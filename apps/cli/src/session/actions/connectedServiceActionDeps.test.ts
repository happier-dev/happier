import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { API_TOKEN_FULL_GRANT_V1, AccountSettingsV2UpdateRequestSchema, accountSettingsParse, buildRecoveryCreditConsumeIdempotencyKey, createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps, type ApprovalRequest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, ConnectedAccountAuthenticationCommandRequestSchema, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowMutationV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ConnectedPresentationRecordV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { StoredCredentials } from '@/persistence';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createCliConnectedMetadataStore } from '@/settings/connected/connectedMetadataStore';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

// History admission also reads independent catalog authorities. This HTTP
// fixture represents an absent Profile control and unsupported unrelated rows.
function unrelatedHistoryAuthorityResponse(path: string) {
  if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
  if ([PROMPT_LIBRARY_ROWS_ROUTE_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ACP_CATALOG_ROWS_ROUTE_V1,
    MCP_SERVER_CATALOG_ROWS_ROUTE_V1, REMOTE_HOST_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1,
    `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`].includes(path)) {
    return { status: 404, data: { error: 'unsupported' } };
  }
}

describe('native connected-service Action adapter', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests(); });

  it('uses exact captured Home, machine and attempt operands for authentication and refuses retired credentials before RPC', async () => {
    const credentials: StoredCredentials = { token: 'authentication-boundary', encryption: null };
    let current = true;
    let issued: unknown = null;
    const action = createCliConnectedServiceAction({ credentials, serverId: 'home-work', serverHttpBaseUrl: 'https://home-work.test',
      isCredentialCurrent: () => current, resolveHeaders: () => ({ Authorization: 'Bearer authentication-boundary' }),
      // The machine RPC is the only substituted boundary; command parsing and the Action semantic adapter are real.
      async callMachineAction(request) {
        expect(request.method).toBe(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD);
        expect(request.serverId).toBe('home-work');
        expect(ConnectedAccountAuthenticationCommandRequestSchema.parse(request.request)).toEqual({ v: 1, machineId: 'controller',
          command: { operation: 'resumeDevice', attemptId: 'attempt-work' } });
        issued = request;
        return { status: 'pending', attemptId: 'attempt-work', retryAfterMs: 500 };
      },
    });
    const execute = () => action({ actionId: ActionIdSchema.parse('connectedServices.authentication.resumeDevice'),
      input: { machineId: 'controller', attemptId: 'attempt-work' }, context: { surface: 'cli', authority: 'present_user' } });
    expect(await execute()).toEqual({ status: 'pending', attemptId: 'attempt-work', retryAfterMs: 500 });
    expect(issued).not.toBeNull();
    issued = null; current = false;
    await expect(execute()).rejects.toMatchObject({ code: 'scope-retired' });
    expect(issued).toBeNull();
  });

  it.each(['signed', 'refused'] as const)('uses genuine requester signing for metadata and fails closed when real authority is %s', async admission => {
    // Reuse the real authority fixture shape and signing vector from
    // api/externalActionExecutionAuthorization.requesterHttp.test.ts.
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
    const actionId = 'connectedServices.accounts.rename' as const;
    const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const input = { account, label: 'Signed Work' };
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = { v: 1 as const, requestId: 'bob-metadata', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'bob-home-proof', binding: {
      accountId: 'bob', principalId: 'bob', credentialId: 'bob-service', grant: API_TOKEN_FULL_GRANT_V1,
      serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: 'alice', installationId: 'alice-installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const tokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const credentials: StoredCredentials = { token: `${tokenPart({ alg: 'none' })}.${tokenPart({
      sub: 'bob', tokenEpoch: 7, provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })}.signature`, encryption: null };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://bob-signed-metadata.test',
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    const assertRequesterHeaders = (url: unknown, headers: Readonly<Record<string, unknown>> | undefined, method: 'GET' | 'POST', body?: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://bob-signed-metadata.test');
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId, target,
        installationId: 'alice-installation', requestId: envelope.requestId, method, path: parsed.pathname,
        ...(body === undefined ? {} : { body }), publicKey: keys.publicKey,
        signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    };
    const network = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      assertRequesterHeaders(url, config?.headers, 'GET');
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'bob', connectedAccountsV4: [{ ref: account,
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationReady: true, configurationRevision: null, scopes: [] }], connectedAccountGroupsV4: [] } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path.endsWith('/connected-metadata/presentation') || path.endsWith('/connected-metadata/acknowledgements')) return {
        status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } },
      };
      return { status: 404, data: { error: 'unsupported' } };
    });
    const writes: unknown[] = [];
    const mutations = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, config) => {
      assertRequesterHeaders(url, config?.headers, 'POST', body);
      expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/connected-metadata/presentation');
      writes.push(body);
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    const action = createCliConnectedServiceAction({ credentials, operationContext,
      resolveHeaders(caller, effectActionId, request) {
        const resolved = resolveExternalActionServerRequestHeaders({ context: caller, effectActionId, ...request,
          daemonToken: 'alice-daemon-must-not-fallback', serverIdentityId: 'srv_bob_home', installationId: 'alice-installation',
          ...(admission === 'signed' ? { privateKey: keys.secretKey } : {}) });
        return resolved.ok ? resolved.headers : null;
      }, callMachineAction: async () => { throw new Error('metadata_is_not_machine_rpc'); } });
    const pending = action({ actionId, input, context });
    if (admission === 'refused') {
      await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
      expect(network).not.toHaveBeenCalled();
      expect(mutations).not.toHaveBeenCalled();
    } else {
      expect(await pending).toEqual({ applied: true });
      expect(writes).toEqual([{ expectedRevision: 1, content: { t: 'plain', v: { v: 1,
        entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Signed Work' }] } } }]);
    }
  });

  it('renames the exact connected account through its row without advancing Account preferences', async () => {
    const credentials: StoredCredentials = { token: 'metadata-action', encryption: null };
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'work-account' };
    const writes: { path: string; body: unknown }[] = [];
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    let presentation = { v: 1, entries: [] as unknown[] };
    let revision = 1;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'metadata-account', connectedAccountsV4: [{ ref: account,
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationReady: true, configurationRevision: null, scopes: [] }], connectedAccountGroupsV4: [] } };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: presentation } } };
      if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
      throw new Error(`Unexpected metadata GET: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body: unknown) => {
      const path = new URL(String(input)).pathname;
      writes.push({ path, body });
      if (path.endsWith('/connected-metadata/presentation')) {
        const mutation = body as { expectedRevision: number; content: { t: 'plain'; v: typeof presentation } };
        expect(mutation.expectedRevision).toBe(revision);
        presentation = mutation.content.v;
        revision += 1;
        return { status: 200, data: { status: 'updated', revision, cursor: revision } };
      }
      return { status: 200, data: { success: true, version: 8 } };
    });
    const action = createCliConnectedServiceAction({ credentials, serverHttpBaseUrl: 'https://metadata-home.test',
      resolveHeaders: () => ({ Authorization: 'Bearer metadata-action' }),
      callMachineAction: async () => { throw new Error('metadata_is_account_owned'); } });
    expect(await action({ actionId: 'connectedServices.accounts.rename', input: { account, label: 'Work' },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } })).toEqual({ applied: true });
    expect(writes).toEqual([{ path: '/v1/account/entity-rows/connected-metadata/presentation', body: {
      expectedRevision: 1, content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Work' }] } },
    } }]);
  });

  it('keeps an other-Home metadata Action in the real requester custody and refuses retired requests', async () => {
    const alice: StoredCredentials = { token: 'alice-metadata', encryption: null };
    const credentials: StoredCredentials = { token: 'bob-metadata', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(alice) });
    const incumbent = getActiveAccountSettingsSnapshot();
    let current = true;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://bob-metadata.test',
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
      isCurrent: async () => current });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'bob' };
    const writes: string[] = [];
    let revision = 1;
    let record: unknown = { v: 1, entries: [] };
    vi.spyOn(axios, 'get').mockImplementation(async (input, config) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://bob-metadata.test');
      expect(config?.headers?.Authorization).toBe('Bearer bob-metadata');
      const path = url.pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'bob', connectedAccountsV4: [{ ref: account,
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationReady: true, configurationRevision: null, scopes: [] }], connectedAccountGroupsV4: [] } };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: record } } };
      if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
      throw new Error(`Unexpected requester metadata GET: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body: unknown) => {
      const path = new URL(String(input)).pathname;
      writes.push(path);
      if (path.endsWith('/connected-metadata/presentation')) {
        // HTTP request bodies are a genuine external boundary; the real store validates them.
        record = (body as { content: { v: unknown } }).content.v;
        revision += 1;
        return { status: 200, data: { status: 'updated', revision, cursor: revision } };
      }
      return { status: 200, data: { success: true, version: 8 } };
    });
    const action = createCliConnectedServiceAction({ credentials, serverHttpBaseUrl: 'https://bob-metadata.test', ...{ operationContext },
      resolveHeaders: () => ({ Authorization: 'Bearer bob-metadata' }), callMachineAction: async () => { throw new Error('metadata_is_not_machine_rpc'); } });
    const args = { actionId: 'connectedServices.accounts.rename' as const, input: { account, label: 'Bob' },
      context: { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } } };
    expect(await action(args)).toEqual({ applied: true });
    expect(writes).toEqual(['/v1/account/entity-rows/connected-metadata/presentation']);
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    current = false;
    await expect(action(args)).rejects.toMatchObject({ code: 'scope-retired' });
    expect(writes).toHaveLength(1);
  });

  it('issues the primary qualified group deletion and absence read on captured requester Home rather than ambient custodian Home', async () => {
    const credentials: StoredCredentials = { token: 'bob-primary-group', encryption: null };
    const group = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work-group' };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://bob-primary.test',
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://bob-primary.test');
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname === '/v1/account/profile') return { status: 200, data: { id: 'bob', connectedAccountsV4: [], connectedAccountGroupsV4: [] } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (url.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      if (url.pathname.includes('/connected-metadata/')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, entries: [] } } } };
      const historyAuthority = unrelatedHistoryAuthorityResponse(url.pathname);
      if (historyAuthority) return historyAuthority;
      throw new Error(`Unexpected captured Home GET: ${url.pathname}`);
    });
    const effects: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const url = new URL(String(config.url));
      expect(url.origin).toBe('https://bob-primary.test');
      expect(url.pathname).toBe('/v4/connect/qualified/group');
      expect(JSON.parse(url.searchParams.get('group')!)).toEqual(group);
      expect(config.headers?.Authorization).toBe('Bearer bob-primary-group');
      effects.push(String(config.method));
      if (config.method === 'DELETE') {
        expect(url.searchParams.get('expectedIncarnation')).toBe('group-1');
        expect(url.searchParams.get('expectedGeneration')).toBe('4');
        return { status: 200, data: { success: true } };
      }
      expect(config.method).toBe('GET');
      return { status: 404, data: { error: 'connect_group_not_found' } };
    });
    const action = createCliConnectedServiceAction({ credentials, operationContext, serverHttpBaseUrl: 'https://alice-custodian.test',
      resolveHeaders: () => ({ Authorization: 'Bearer bob-primary-group' }),
      callMachineAction: async () => { throw new Error('group_mutation_is_http'); } });
    expect(await action({ actionId: 'connectedServices.pools.delete', input: { group, expectedIncarnation: 'group-1', expectedGeneration: 4 },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } })).toEqual({ applied: true, metadataCleanup: { status: 'complete' } });
    expect(effects).toEqual(['DELETE', 'GET']);
  });

  it.each(['ack-after-retirement', 'lost-ack'] as const)('keeps an exact machine warning false and preserves %s without replay', async outcome => {
    const credentials: StoredCredentials = { token: 'machine-warning', encryption: null };
    let current = true;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://machine-warning.test',
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => current });
    const accountWarning = { v: 1, subject: { kind: 'warning', warningId: '', scope: { kind: 'account' } }, acknowledged: true };
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'machine-warning', connectedAccountsV4: [], connectedAccountGroupsV4: [] } };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, entries: [] } } } };
      if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision: 2,
        content: { t: 'plain', v: { v: 1, entries: [accountWarning] } } } };
      throw new Error(`Unexpected warning GET: ${path}`);
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body: unknown) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/connected-metadata/acknowledgements');
      writes.push(body);
      current = false;
      if (outcome === 'lost-ack') throw Object.assign(new Error('The accepted request lost its acknowledgement'), { code: 'ECONNRESET' });
      return { status: 200, data: { status: 'updated', revision: 3, cursor: 3 } };
    });
    const subject = { kind: 'warning' as const, warningId: '', scope: { kind: 'machine' as const, machineId: 'exact-machine' } };
    const action = createCliConnectedServiceAction({ credentials, ...{ operationContext },
      resolveHeaders: () => ({ Authorization: 'Bearer machine-warning' }), callMachineAction: async () => { throw new Error('ack_is_not_machine_rpc'); } });
    const pending = action({ actionId: 'connectedServices.acknowledgements.set', input: { subject, acknowledged: false },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } });
    if (outcome === 'lost-ack') await expect(pending).rejects.toMatchObject({ code: 'outcome_unknown' });
    else expect(await pending).toEqual({ applied: true });
    expect(writes).toEqual([{ expectedRevision: 2, content: { t: 'plain', v: { v: 1,
      entries: expect.arrayContaining([accountWarning, { v: 1, subject, acknowledged: false }]) } } }]);
  });

  it('cleans exact pre-delete historical keys after revocation without losing readable metadata or ambiguous neighbors', async () => {
    const credentials: StoredCredentials = { token: 'historical-delete', encryption: null };
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'default' };
    const peer = { service, accountId: 'other' };
    const ambiguousAccounts = [{ service, accountId: 'folder%2Faccount' }, { service, accountId: 'folder/account' }];
    const raw = { futurePreference: 'retained', dismissedCLIWarnings: { global: { unrelated: false }, perMachine: { machine: { unrelated: true } } },
      connectedServicesProfileLabelByKey: { 'openai-codex/folder%2Faccount': 'Ambiguous source label' },
      connectedServicesCollapsedItemKeysV1: { 'happier.agent.codex/openai-codex:account:default': true,
        'openai-codex:account:default': false, 'openai-codex:pool:work-team:default': true,
        'openai-codex:account:other': false, 'opaque-predecessor-key': true } };
    let source: Readonly<Record<string, unknown>> = raw;
    let sourceVersion = 7;
    let deleted = false;
    let presentation: ConnectedPresentationRecordV1 = { v: 1, entries: [
      { v: 1, subject: { kind: 'account', account }, label: 'Delete target' },
      { v: 1, subject: { kind: 'account', account: peer }, label: 'Keep peer' },
    ] };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://historical-delete.test',
      snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: sourceVersion,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: sourceVersion, content: { t: 'plain', v: source } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
      } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'historical-delete',
        connectedAccountsV4: [...(deleted ? [] : [account]), peer, ...ambiguousAccounts].map(ref => ({ ref,
          status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
          configurationReady: true, configurationRevision: null, scopes: [] })),
        connectedAccountGroupsV4: deleted ? [] : [{ v: 1, ref: { service, groupId: 'work-team' }, incarnation: 'group-1', displayName: 'Work team',
          policy: { autoSwitch: false }, activeConnectedAccountId: 'default', generation: 1, runtimeStateRevision: 0,
          state: {}, createdAt: 1, updatedAt: 1, members: [{ v: 1, connectedAccountId: 'default', priority: 0,
            enabled: true, state: {}, createdAt: 1, updatedAt: 1 }] }],
      } };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: presentation } } };
      if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 503, data: { error: 'unreachable' } };
      throw new Error(`Unexpected deletion GET: ${path}`);
    });
    const settingsWrites: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body: unknown) => {
      const path = new URL(String(input)).pathname;
      expect(deleted).toBe(true);
      if (path.endsWith('/connected-metadata/presentation')) {
        const mutation = body as { expectedRevision: number; content: { t: 'plain'; v: ConnectedPresentationRecordV1 } };
        expect(mutation.expectedRevision).toBe(1);
        presentation = mutation.content.v;
        return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
      }
      expect(path).toBe('/v2/account/settings');
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(7);
      expect(mutation.content?.t).toBe('plain');
      if (mutation.content?.t === 'plain') { source = mutation.content.v; settingsWrites.push(source); }
      sourceVersion += 1;
      return { status: 200, data: { success: true, version: sourceVersion } };
    });
    const action = createCliConnectedServiceAction({ credentials, ...{ operationContext },
      resolveHeaders: () => ({ Authorization: 'Bearer historical-delete' }),
      async callMachineAction(request) {
        const command = ConnectedAccountControlCommandRequestSchema.parse(request.request).command;
        expect(command).toMatchObject({ operation: 'revokeAccount', account });
        deleted = true;
        return { status: 'revoked', account, remoteStatus: 'remoteRevoked' };
      } });
    const expectedSource = { ...raw, connectedServicesCollapsedItemKeysV1: {
      // Conflicting aliases for the same account stay opaque; the independently
      // proven group-member key is still removable after the definite receipt.
      'happier.agent.codex/openai-codex:account:default': true,
      'openai-codex:account:default': false,
      'openai-codex:account:other': false, 'opaque-predecessor-key': true,
    } };
    const prepared = await createCliConnectedMetadataStore({ credentials, operationContext,
      authorizeRequest: () => ({ Authorization: 'Bearer historical-delete' }) }).prepareCleanup({ kind: 'account', account });
    expect(prepared).toMatchObject({ raw: expectedSource, expectedVersion: 7, mode: 'plain', incomplete: true });
    expect(await action({ actionId: 'connectedServices.accounts.revoke', input: { account, machineId: 'machine', cleanupGroupReferences: false },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } })).toMatchObject({
      status: 'revoked', account, metadataCleanup: { status: 'cleanup-pending' },
    });
    expect(presentation.entries).toEqual([{ v: 1, subject: { kind: 'account', account: peer }, label: 'Keep peer' }]);
    expect(settingsWrites).toEqual([expectedSource]);
  });

  it('settles a pool mutation with unknown outcome when the server never replies', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '1000');
    let accepted = false;
    const server = createServer((request) => {
      request.resume();
      request.on('end', () => { accepted = true; });
      // The HTTP boundary accepts the mutation but deliberately withholds its acknowledgement.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const action = createCliConnectedServiceAction({
      credentials: { token: 'boundary-token', encryption: null },
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`,
      resolveHeaders: () => ({ Authorization: 'Bearer boundary-token' }),
      callMachineAction: async () => { throw new Error('pool_creation_is_http'); },
    });
    try {
      await expect(action({ actionId: 'connectedServices.pools.create',
        input: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, group: { groupId: 'pool-boundary' } },
        context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
      })).rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(accepted).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 4000);

  it('admits a qualified quota refresh on the selected Home machine and preserves an HTTP refusal', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'work-account' };
    const machineRequests: unknown[] = [];
    const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { success: true } });
    const action = createCliConnectedServiceAction({ credentials: { token: 'boundary-token', encryption: null },
      serverId: 'work-home', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { return { Authorization: 'Bearer boundary-token' }; },
      async callMachineAction(request) {
        machineRequests.push(request);
        return { status: 'described', service,
          descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] } },
          occurrenceId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
          accounts: [], operationTransport: { kind: 'v4' },
        };
      },
    });
    const args = { actionId: 'connectedServices.quota.refresh' as const, input: { account, machineId: 'work-machine' }, context: { surface: 'cli' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } } };
    expect(await action(args)).toEqual({ applied: true });
    expect(machineRequests).toEqual([{ machineId: 'work-machine', serverId: 'work-home', method: 'daemon.connectedAccounts.control.command',
      request: { v: 1, machineId: 'work-machine', command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } } }]);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://work.invalid/v4/connect/qualified/quotas/refresh', method: 'POST', data: { ref: account } }));
    http.mockResolvedValue({ status: 404, data: { error: 'quota_refresh_unavailable' } });
    await expect(action(args)).rejects.toMatchObject({ code: 'quota_refresh_unavailable' });
  });

  it('persists a default through the real purpose row and qualified Agent catalog without rewriting unrelated preferences', async () => {
    const credentials: StoredCredentials = { token: 'purpose-default', encryption: null };
    const raw = { futureSetting: { retained: true },
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 1,
        bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-default' } } } } },
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } };
    let source: Readonly<Record<string, unknown>> = raw;
    let sourceVersion = 1;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://work.invalid',
      snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    let written: unknown;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: sourceVersion, content: { t: 'plain', v: source } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      if (url.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      throw new Error(`Unexpected HTTP request: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown) => {
      expect(url).toBe('https://work.invalid/v1/account/entity-rows/connected-accounts/purposes');
      const request = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
      expect(request.expectedRevision).toBe(1);
      expect(request.settingsMutation).toMatchObject({ expectedSettingsVersion: 1, content: { t: 'plain', v: {
        futureSetting: { retained: true }, connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
        connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
      } } });
      if (request.settingsMutation?.content?.t === 'plain') source = request.settingsMutation.content.v;
      sourceVersion = 2;
      if (request.content?.t === 'plain') written = request.content.v;
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2, settingsVersion: sourceVersion } };
    });
    const action = createCliConnectedServiceAction({
      credentials, operationContext,
      resolveHeaders: () => ({ Authorization: 'Bearer purpose-default' }),
      callMachineAction: async () => { throw new Error('configuration_is_not_machine_rpc'); },
    });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    await expect(action({
      actionId: 'connectedServices.pools.default.set',
      input: { group: { service, groupId: 'work-group' }, agentId: 'codex', makeDefault: true },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
    })).resolves.toEqual({ applied: true });
    expect(written).toMatchObject({ key: 'purposes', value: {
      bindings: [{ purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        target: { kind: 'group', service, groupId: 'work-group' } }],
    } });
    expect(operationContext.readSnapshot()?.rawSettings).toEqual(source);
    expect(source).toEqual({ futureSetting: { retained: true },
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } });
  });

  it('admits Resource purpose preferences only from the exact target daemon and active captured Account profile', async () => {
    const credentials: StoredCredentials = { token: 'resource-purpose', encryption: null };
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const purpose = { consumer: { pluginId: 'example.resource', localId: 'models' }, purpose: 'model' };
    const target = { kind: 'account' as const, account: { service, accountId: 'work' } };
    let enabled = true;
    let current = true;
    let writes = 0;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://resource-home.test',
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => current });
    // HTTP and machine RPC are the only substituted boundaries; declaration, profile and catalog admission are real.
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.url).toBe('https://resource-home.test/v1/account/profile');
      expect(request.headers).toMatchObject({ Authorization: 'Bearer resource-purpose' });
      return { status: 200, data: { id: 'account', connectedAccountsV4: [{ ref: target.account, status: 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationReady: true, configurationRevision: null, scopes: [] }], connectedAccountGroupsV4: [] } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      throw new Error(`Unexpected Resource purpose HTTP: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      expect(url).toBe('https://resource-home.test/v1/account/entity-rows/connected-accounts/purposes');
      const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
      expect(mutation.content).toMatchObject({ t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose, target }] } } });
      writes += 1;
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
    });
    const action = createCliConnectedServiceAction({ credentials, operationContext, serverId: 'resource-home',
      resolveHeaders: () => ({ Authorization: 'Bearer resource-purpose' }),
      callMachineAction: async request => {
        expect(request).toMatchObject({ machineId: 'resource-machine', serverId: 'resource-home',
          method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE });
        return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {},
          installedPackagesById: { 'example.resource': { id: 'example.resource', displayName: 'Resource', enabled,
            source: { kind: 'builtin', locator: 'example.resource' } } },
          resourcesById: { models: { id: 'models', pluginId: 'example.resource', resourceKind: 'config', path: 'models.json',
            connectedAccountPurposes: [{ purpose: 'model', serviceRefs: [service] }] } },
        } };
      },
    });
    const execute = () => action({ actionId: ActionIdSchema.parse('connectedServices.purposes.default.set'),
      input: { machineId: 'resource-machine', purpose, target }, context: { surface: 'cli', authority: 'present_user' } });
    expect(await execute()).toEqual({ applied: true });
    expect(writes).toBe(1);
    enabled = false;
    expect(await execute()).toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    expect(writes).toBe(1);
    current = false;
    await expect(execute()).rejects.toMatchObject({ code: 'scope-retired' });
    expect(writes).toBe(1);
  });

  it.each(['complete', 'history-forbidden'] as const)('clears requester purpose and label rows only after definite connected-account revocation and reports %s maintenance', async maintenance => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'work-account' };
    const credentials: StoredCredentials = { token: 'review-custody', encryption: null };
    const raw = { futureSetting: { retained: true },
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 1,
        bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: account.accountId } } } } },
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } };
    let source: Readonly<Record<string, unknown>> = raw;
    let sourceVersion = 1;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://work.invalid',
      snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    let purposes: ConnectedPurposeCatalogV1 = { v: 1, bindings: [{ purpose: {
      consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' }, target: { kind: 'account', account } }] };
    let presentation: ConnectedPresentationRecordV1 = { v: 1, entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Work' }] };
    const writes: string[] = [];
    let response: unknown = { status: 'removalReviewRequired', account, resources: [] };
    let historyRead = false;
    // HTTP/settings persistence and daemon RPC are boundaries. The canonical
    // Action adapter and Account mutation owner stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      expect(new URL(url).origin).toBe('https://work.invalid');
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: sourceVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: sourceVersion, content: { t: 'plain', v: source } } };
      if (url.endsWith('/v2/account/settings/history')) {
        historyRead = true;
        return maintenance === 'history-forbidden'
          ? { status: 403, data: { error: 'forbidden' } } : { status: 200, data: { snapshots: [] } };
      }
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'review-custody', connectedAccountsV4: [{ ref: account,
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationReady: true, configurationRevision: null, scopes: [] }], connectedAccountGroupsV4: [] } };
      if (url.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: purposes } } } };
      if (url.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: presentation } } };
      if (url.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, entries: [] } } } };
      const historyAuthority = unrelatedHistoryAuthorityResponse(new URL(url).pathname);
      if (historyAuthority) return historyAuthority;
      throw new Error(`Unexpected HTTP request: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown) => {
      expect(response).toMatchObject({ status: 'revoked' });
      writes.push(new URL(url).pathname);
      if (url.endsWith('/connected-accounts/purposes')) {
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
        expect(mutation.settingsMutation).toMatchObject({ expectedSettingsVersion: 1, content: { t: 'plain', v: {
          futureSetting: { retained: true }, connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
          connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
        } } });
        if (mutation.settingsMutation?.content?.t === 'plain') source = mutation.settingsMutation.content.v;
        sourceVersion = 2;
        if (mutation.content?.t === 'plain' && mutation.content.v.key === 'purposes') purposes = mutation.content.v.value;
      } else if (url.endsWith('/connected-metadata/presentation')) {
        presentation = (body as { content: { v: ConnectedPresentationRecordV1 } }).content.v;
      } else throw new Error(`Unexpected HTTP mutation: ${url}`);
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 2,
        ...(url.endsWith('/connected-accounts/purposes') ? { settingsVersion: sourceVersion } : {}) } };
    });
    const action = createCliConnectedServiceAction({
      credentials, operationContext, serverId: 'work-home', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders: () => ({ Authorization: 'Bearer review-custody' }),
      async callMachineAction(request) {
        expect(request).toMatchObject({ serverId: 'work-home', machineId: 'work-machine',
          method: 'daemon.connectedAccounts.control.command', request: { v: 1, machineId: 'work-machine',
            command: { operation: 'revokeAccount', account, cleanupGroupReferences: false } } });
        return response;
      },
    });
    const args = { actionId: 'connectedServices.accounts.revoke' as const,
      input: { account, machineId: 'work-machine', cleanupGroupReferences: false },
      context: { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } } };
    expect(await action(args)).toEqual(response);
    expect(historyRead).toBe(true);
    expect(writes).toEqual([]);
    expect(purposes.bindings).toHaveLength(1);
    expect(presentation.entries).toHaveLength(1);
    response = { status: 'revoked', account, remoteStatus: 'remoteRevoked' };
    expect(await action(args)).toMatchObject({ ...response as object,
      metadataCleanup: { status: maintenance === 'complete' ? 'complete' : 'cleanup-pending' } });
    expect(purposes.bindings).toEqual([]);
    expect(presentation.entries).toEqual([]);
    expect(writes).toEqual(['/v1/account/entity-rows/connected-accounts/purposes', '/v1/account/entity-rows/connected-metadata/presentation']);
    expect(operationContext.readSnapshot()?.rawSettings).toEqual(source);
    expect(source).toEqual({ futureSetting: { retained: true },
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} } });
  });

  it('captures the published credential revision before the shared revoke Ask without issuing a revoke', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const account = { service, accountId: 'work-account' };
    const presentedRevision = 'csr_abcdefghijklmnopqrstuv';
    let currentRevision = presentedRevision;
    let nativeEffectIssued = false;
    const requests: unknown[] = [];
    const connectedServiceAction = createCliConnectedServiceAction({
      credentials: { token: 'boundary-token', encryption: null }, serverId: 'work-home', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { throw new Error('revision_preparation_uses_daemon_profile_owner'); },
      async callMachineAction(request) {
        requests.push(request);
        const command = ConnectedAccountControlCommandRequestSchema.parse(request.request).command;
        if (command.operation === 'revokeAccount') {
          if (command.expectedCredentialRevision !== currentRevision) return { status: 'conflict', code: 'connect_credential_mutation_superseded' };
          nativeEffectIssued = true;
          return { status: 'revoked', account, remoteStatus: 'remoteUnsupported' };
        }
        return { status: 'described', service,
          descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] } },
          occurrenceId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
          accounts: [{ ref: account, status: 'connected', authenticationModeId: 'oauth', configurationReady: true,
            configurationRevision: null, scopes: [], revisionSemantics: 'revisioned', credentialRevision: currentRevision }],
          operationTransport: { kind: 'v4' },
        };
      },
    });
    // The transport is substituted; the mounted CLI adapter and canonical
    // Action admission/approval preparation remain real.
    let reviewedInput: unknown;
    const createdApprovals: ApprovalRequest[] = [];
    let storedApproval: ApprovalRequest | null = null;
    const deps: Pick<ActionExecutorDeps, 'connectedServiceAction' | 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'> = {
      connectedServiceAction,
      async approvalsCreate({ request }) { createdApprovals.push(request); storedApproval = request; reviewedInput = request.actionArgs; return { artifactId: 'credential-revoke-review' }; },
      async approvalsGet() { return storedApproval; },
      async approvalsUpdate({ request }) { storedApproval = request; return { ok: true }; },
      async isApprovalExecutionOriginCurrent() { return true; },
    };
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const input = { account, machineId: 'work-machine', cleanupGroupReferences: false };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
      serverId: 'work-home', actionRequestId: 'credential-review:1' };
    expect(await executor.execute('connectedServices.accounts.revoke', input, context)).toEqual({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'credential-revoke-review', actionId: 'connectedServices.accounts.revoke',
    } });
    expect(reviewedInput).toEqual({ ...input, expectedCredentialRevision: presentedRevision });
    expect(requests).toEqual([{ machineId: 'work-machine', serverId: 'work-home', method: 'daemon.connectedAccounts.control.command',
      request: { v: 1, machineId: 'work-machine', command: { operation: 'describeService', service, requiredOperation: 'credential_delete' } } }]);
    expect(nativeEffectIssued).toBe(false);
    currentRevision = 'csr_zyxwvutsrqponmlkjihgfe';
    expect(await executor.execute('approval.request.decide', { artifactId: 'credential-revoke-review', decision: 'approve' }, {
      ...context, surface: 'ui', actionRequestId: 'credential-review:decision',
    })).toMatchObject({ ok: true, result: { status: 'executed', execution: {
      ok: true, result: { status: 'conflict', code: 'connect_credential_mutation_superseded' },
    } } });
    expect(reviewedInput).toEqual({ ...input, expectedCredentialRevision: presentedRevision });
    expect(nativeEffectIssued).toBe(false);
    expect(requests.at(-1)).toMatchObject({ request: { command: { operation: 'revokeAccount', expectedCredentialRevision: presentedRevision } } });
    const initialApproval = createdApprovals[0];
    if (!initialApproval) throw new Error('Missing initial approval Artifact');
    storedApproval = { ...initialApproval, actionArgs: input };
    const beforeMissingRevisionReplay = requests.length;
    expect(await executor.execute('approval.request.decide', { artifactId: 'credential-revoke-review', decision: 'approve' }, {
      ...context, surface: 'ui', actionRequestId: 'credential-review:missing-revision',
    })).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'approval_stale' } } });
    expect(requests).toHaveLength(beforeMissingRevisionReplay);
  });

  it('reaches the selected Home machine reset owner with the same recovery-credit identity as the app and preserves a refusal', async () => {
    const credentials = { token: 'boundary-test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } } satisfies StoredCredentials;
    const observed: unknown[] = [];
    // Machine RPC is the external system boundary; request parsing and recovery-key ownership stay real.
    const action = createCliConnectedServiceAction({ credentials, serverId: 'home-work', serverHttpBaseUrl: 'https://work.invalid',
      resolveHeaders() { throw new Error('quota_reset_is_not_http'); },
      async callMachineAction(request) {
        observed.push(request);
        return { ok: false, errorCode: 'reset_unavailable', error: 'reset_unavailable' };
      },
    });
    const input = { machineId: 'machine-work', serviceId: 'openai-codex' as const, profileId: 'account-work', providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 10 };
    expect(await action({ actionId: 'connectedServices.quota.reset', input, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } }))
      .toEqual({ ok: false, errorCode: 'reset_unavailable', error: 'reset_unavailable' });
    expect(observed).toEqual([{ machineId: 'machine-work', serverId: 'home-work', method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME, request: {
      serviceId: 'happier.agent.codex/openai-codex', profileId: input.profileId, providerCreditId: input.providerCreditId,
      idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey(input),
    } }]);
  });
});
