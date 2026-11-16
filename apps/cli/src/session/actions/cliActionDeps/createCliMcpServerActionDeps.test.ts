import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import nacl from 'tweetnacl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { callSocketRpc } from '@happier-dev/sync-client';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { createCliMcpServerActionExecuteV1 } from './createCliMcpServerActionDeps';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  ConnectedAccountAuthenticationCommandRequestSchema, ConnectedAccountControlCommandRequestSchema,
  ConnectedAccountAttemptResponseSchema, ConnectedAccountDaemonControlResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as service } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR } from '@/mcp/oauth/mcpSignInRuntime';
import { createCliConnectedServiceAction } from '../connectedServiceActionDeps';
import { tryHandleMcpServerCliCommand } from '@/cli/actions/adapters/mcpServersArgv';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { ApprovalRequestSchema, createBlockingApprovalCoordinator, type ApprovalRequest } from '@happier-dev/protocol';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

describe('MCP Machine Action transport disposition', () => {
  it('retains the requester HTTP proof for Machine administration and tool inventory, refusing retired or mismatched custody', async () => {
    const inventoryHeaders: (string | undefined)[] = [];
    const catalogHeaders: (string | undefined)[] = [];
    const catalogBearerHeaders: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.endsWith('/execution-authorization/verify')) return response.end(JSON.stringify({ ok: true }));
      if (request.url === '/v1/account/encryption/currentness') return response.end(JSON.stringify({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      if (request.url === '/v1/machines') {
        inventoryHeaders.push(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]?.toString());
        expect(request.headers.authorization).toBeUndefined();
        return response.end(JSON.stringify([{ id: 'selected-machine', active: true, activeAt: Date.now(), revokedAt: null,
          replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null }]));
      }
      if (request.url === '/v1/account/entity-rows/mcp') {
        catalogHeaders.push(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]?.toString());
        catalogBearerHeaders.push(request.headers.authorization);
        return response.end(JSON.stringify({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'http',
          remote: { url: 'https://mcp.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' } },
          env: {}, createdAt: 1, updatedAt: 1 }] } } }));
      }
      if (request.url === '/v1/account/entity-rows/profiles/transfer') return response.end(JSON.stringify({ status: 'absent' }));
      response.statusCode = 404;
      return response.end('{}');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    const base = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-requester' })).toString('base64url')}.signature`, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const machineRequests: string[] = [];
    const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
      callMachineAction: async request => {
        machineRequests.push(request.machineId);
        expect(request.authorization).toEqual({ kind: 'session.write', sessionId: 'caller-session' });
        return { status: 'unavailable', code: 'connected_account_service_unavailable' };
      } });
    let current = true;
    for (const actionId of ['mcp.servers.signIn.start', 'mcp.servers.tools.list'] as const) {
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `requester-${actionId}`, binding: {
        accountId: 'mcp-requester', custodianAccountId: 'machine-custodian', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'selected-machine', installationId: 'installation',
        actionId, requestId: 'requester-mcp', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'selected-machine' },
      } });
      const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
        serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: base, target: root.binding.target,
        installationId: 'installation', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19)).secretKey,
        isCurrent: async () => current });
      if (!authorization?.requesterHttpProjection) throw new Error('Missing real requester HTTP projection');
      const context = { surface: 'cli' as const, authority: 'account_automation' as const, serverId: 'home',
        rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'caller-session' },
        externalActionExecutionAuthorization: authorization };
      const before = inventoryHeaders.length;
      const catalogBefore = catalogHeaders.length;
      const receipt = await execute({ actionId, input: { serverId: 'server' }, context });
      expect(inventoryHeaders.slice(before)).toEqual([root.token]);
      expect(catalogHeaders.slice(catalogBefore)).not.toHaveLength(0);
      expect(catalogHeaders.slice(catalogBefore).every(token => token === root.token)).toBe(true);
      expect(catalogBearerHeaders.slice(catalogBefore).every(value => value === undefined)).toBe(true);
      expect(receipt).toMatchObject(actionId === 'mcp.servers.signIn.start'
        ? { ok: false, errorCode: 'mcp_sign_in_not_supported' } : { ok: true });
      for (const mismatch of [{ accountId: 'another-account' }, { serverHttpBaseUrl: 'https://another-home.test' }]) {
        await execute({ actionId, input: { serverId: 'server' }, context: { ...context,
          externalActionExecutionAuthorization: { ...authorization,
            requesterHttpProjection: { ...authorization.requesterHttpProjection, ...mismatch } } } });
        expect(inventoryHeaders.length).toBe(before + 1);
      }
      current = false;
      await execute({ actionId, input: { serverId: 'server' }, context });
      expect(inventoryHeaders.length).toBe(before + 1);
      current = true;
    }
    expect(machineRequests).toEqual(['selected-machine']);
  });
  it.each([false, true])('returns the full JSON start receipt through the generated CLI and real Connected Account adapters (approval=%s)', async approvalRequired => {
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (request.url === '/v1/machines') response.end(JSON.stringify(['other-machine', 'selected-machine'].map(id => ({
        id, active: true, activeAt: id === 'selected-machine' ? 1 : Date.now(), revokedAt: null,
        replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null }))));
      else if (request.url === '/v1/account/entity-rows/mcp') response.end(JSON.stringify({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'fixture', transport: 'http',
          remote: { url: 'https://mcp.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' } },
          env: {}, createdAt: 1, updatedAt: 1 }] } } }));
      else if (request.url === '/v1/account/entity-rows/profiles/transfer') response.end(JSON.stringify({ status: 'absent' }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const mode = MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR.authentication.modes.find(mode => mode.id === 'oauth');
      if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Missing MCP OAuth descriptor');
      const commands: { machineId: string; operation: string }[] = [];
      let values: Record<string, unknown> = {};
      const callMachineAction: Parameters<typeof createCliMcpServerActionExecuteV1>[0]['callMachineAction'] = async request => {
        // The admitted daemon's RPC transport is the only substituted system
        // boundary. Both command producers and their strict consumers stay real.
        if (request.method === CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD) {
          const { machineId, command } = ConnectedAccountControlCommandRequestSchema.parse(request.request);
          commands.push({ machineId, operation: command.operation });
          if (command.operation === 'describeService') return ConnectedAccountDaemonControlResponseSchema.parse({
            status: 'described', service, descriptor: MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR,
            occurrenceId: 'host-generation', sourceCustody: { kind: 'host' }, accounts: [], operationTransport: { kind: 'v4' } });
          if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
            if (command.operation === 'replaceConfiguration') values = { ...command.values };
            return ConnectedAccountDaemonControlResponseSchema.parse({
              status: command.operation === 'readConfiguration' ? 'configuration' : 'configurationCommitted',
              target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, mode,
              occurrenceId: 'host-generation', sourceCustody: { kind: 'host' },
              configuration: { status: 'ready', revision: command.operation === 'readConfiguration' ? null : 'config-1',
                values, configuredSecretFieldIds: [], missingFieldIds: [] } });
          }
        } else if (request.method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) {
          const { machineId, command } = ConnectedAccountAuthenticationCommandRequestSchema.parse(request.request);
          commands.push({ machineId, operation: command.operation });
          if (command.operation === 'beginConnect') return ConnectedAccountAttemptResponseSchema.parse({ status: 'configurationRequired',
            attemptId: 'attempt', target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, missingFieldIds: ['serverId', 'resource'] });
          if (command.operation === 'continueConnect') return ConnectedAccountAttemptResponseSchema.parse({ status: 'starting', attemptId: 'attempt' });
          if (command.operation === 'read' && command.waitForProviderStart) return ConnectedAccountAttemptResponseSchema.parse({ status: 'awaitingOAuth',
            attemptId: 'attempt', authorizationUrl: 'https://issuer.fixture.test/authorize', callbackUrl: mode.callbackUrl, expiresAtMs: 5000 });
        }
        throw new Error('Unexpected Machine command');
      };
      const connectedServiceAction = createCliConnectedServiceAction({ credentials, serverId: 'home', serverHttpBaseUrl: base,
        resolveHeaders: () => ({ Authorization: 'Bearer fixture' }), callMachineAction });
      const output = captureConsoleJsonOutput<unknown>();
      const capturedMachineIds: (string | undefined)[] = [];
      const coordinator = createBlockingApprovalCoordinator();
      let storedApproval: ApprovalRequest | null = null;
      let origin: ReturnType<typeof createActionExecutor> | undefined;
      const invocation = tryHandleMcpServerCliCommand({ argv: ['mcp', 'servers', 'sign-in', 'fixture', '--machine-id', 'selected-machine', '--no-open', '--json'],
        actionExecutionDeps: { readCredentialsFn: async () => credentials, createExecutorFn: async input => {
          capturedMachineIds.push(input.machineId);
          // Keep the real MCP/Connected Account owner beneath the boundaries;
          // the credentialed CLI context carries the explicit Machine selector.
          const mcpServerAction = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
            connectedServiceAction, callMachineAction });
          const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), mcpServerAction, connectedServiceAction,
            // Artifact persistence is the other substituted system boundary;
            // real codecs, transition admission and live coordinator run below.
            approvalsCreate: async ({ request }) => { storedApproval = ApprovalRequestSchema.parse(request); return { artifactId: 'oauth-approval' }; },
            approvalsGet: async () => storedApproval,
            approvalsUpdate: async ({ request }) => {
              if (!storedApproval) throw new Error('Missing approval');
              const next = ApprovalRequestSchema.parse(request);
              const transition = decideApprovalRequestTransition(storedApproval, next);
              if (!transition.ok) return transition;
              storedApproval = next;
              return { ok: true };
            },
            approvalsWaitForDecision: async args => {
              const decision = await coordinator.waitForDecision(args);
              return { ...decision, request: ApprovalRequestSchema.parse(decision.request) };
            },
            approvalsResolveBlockingDecision: args => coordinator.resolveBlockingDecision(args),
            isApprovalExecutionOriginCurrent: async () => true,
            readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'mcp.servers.signIn.start': approvalRequired ? [] : ['cli'] } }) });
          origin = executor;
          return { ...executor, execute: (id, input, context) => executor.execute(id, input, {
            ...context, serverId: 'home', actionRequestId: 'oauth-start', defaultSessionMachineId: 'selected-machine',
          }), async resolveSessionTarget() { throw new Error('Unexpected Session target'); } };
        } } });
      try {
        if (approvalRequired) {
          await vi.waitFor(() => expect(coordinator.getLiveWaiterCount('oauth-approval')).toBe(1));
          expect(await origin!.execute('approval.request.decide', { artifactId: 'oauth-approval', decision: 'approve' },
            { surface: 'ui', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } }))
            .toMatchObject({ ok: true });
        }
        expect(await invocation).toBe(true);
        if (approvalRequired) {
          expect(storedApproval).toMatchObject({ status: 'executed', execution: { ok: true, result: { machineId: 'selected-machine' } } });
          expect(JSON.stringify(storedApproval)).not.toContain('https://issuer.fixture.test/authorize');
        }
      } finally { coordinator.dispose(); await invocation; }
      expect(process.exitCode ?? 0).toBe(0);
      expect(capturedMachineIds).toEqual(['selected-machine']);
      expect(output.json()).toEqual({ v: 1, ok: true, kind: 'mcp_servers_sign_in', data: {
        attemptId: 'attempt', machineId: 'selected-machine', authorizationUrl: 'https://issuer.fixture.test/authorize', expiresAtMs: 5000 } });
      expect(values).toMatchObject({ serverId: 'server', resource: 'https://mcp.fixture.test/mcp', stepUp: false });
      expect(commands).toEqual(['describeService', 'beginConnect', 'readConfiguration', 'replaceConfiguration', 'continueConnect', 'read']
        .map(operation => ({ machineId: 'selected-machine', operation })));
    });
  });
  it.each([true, false])('keeps sign-in administration on the admitted Machine and automatic selection on reachable Machines (explicit=%s)', async explicit => {
    const machines = ['other-machine', 'selected-machine'].map(id => ({ id, active: id !== 'selected-machine',
      activeAt: Date.now(),
      revokedAt: null, replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null }));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (request.url === '/v1/machines') response.end(JSON.stringify(machines));
      else if (request.url === '/v1/account/entity-rows/mcp') response.end(JSON.stringify({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'http',
          remote: { url: 'https://mcp.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' } },
          env: {}, createdAt: 1, updatedAt: 1 }] } } }));
      else if (request.url === '/v1/account/entity-rows/profiles/transfer') response.end(JSON.stringify({ status: 'absent' }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const destinations: string[] = [];
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
        // The daemon RPC transport is the boundary. Its typed refusal ends the
        // flow after observing the administration destination selected by the owner.
        callMachineAction: async request => {
          destinations.push(request.machineId);
          return { status: 'unavailable', code: 'connected_account_service_unavailable' };
        } });
      const result = await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' },
          ...(explicit ? { externalActionTarget: { kind: 'machine' as const, machineId: 'selected-machine' } } : {}) } });
      expect(result).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
      expect(destinations).toEqual([explicit ? 'selected-machine' : 'other-machine']);
    });
  });
  it('lists generated facts only for Agents installed on current Account Machines, including offline Machines', async () => {
    const codec = createMachineContentCodec({ encryptionMode: 'plain' });
    let inventoryAvailable = true;
    const machine = (id: string, agentId: string, active: boolean, revokedAt: number | null = null) => ({
      id, active, revokedAt, replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null,
      metadata: codec.encodeStored(MachinePublishedMetadataV1Schema.parse({ host: id, platform: 'linux',
        happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
        agentInventory: { checkedAt: 1, installedAgentIds: [agentId] } })),
    });
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (request.url === '/v1/machines' && !inventoryAvailable) { response.statusCode = 503; response.end('{}'); }
      else if (request.url === '/v1/machines') response.end(JSON.stringify([
        machine('online', 'claude', true), machine('offline', 'kilo', false), machine('revoked', 'pi', false, 2),
      ]));
      else if (request.url === '/v1/account/entity-rows/mcp') response.end(JSON.stringify({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'stdio',
          stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] } } }));
      else if (request.url === '/v1/account/entity-rows/profiles/transfer') response.end(JSON.stringify({ status: 'absent' }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
        callMachineAction: async () => { throw new Error('Tools list does not launch a Machine operation'); } });
      const read = await execute({ actionId: 'mcp.servers.read', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } } });
      expect(read).toMatchObject({ ok: true, result: { status: 'present', installLink: expect.any(String) } });
      const definition = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(read.ok ? read.result : null);
      if (!('installLink' in definition) || typeof definition.installLink !== 'string') throw new Error('Missing install link');
      expect(new URL(definition.installLink).origin).toBe(base);
      const receipt = await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } } });
      if (!receipt.ok) throw new Error(receipt.errorCode);
      const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
      expect(listed.perAgent.agents).toEqual([
        { agentId: 'claude', off: 'hidden', approval: 'host', loading: 'every_turn', tokens: null },
        { agentId: 'kilo', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
      ]);
      inventoryAvailable = false;
      expect(await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } } }))
        .toMatchObject({ ok: true, result: { perAgent: { status: 'unavailable', agents: [] } } });
    });
  });
  it('reports an issued cancelled process test as unknown, not as an unexecuted cancellation', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const issued = createDeferred<void>();
      const reply = createDeferred<unknown>();
      const controller = new AbortController();
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
          // Socket emit is the replaced boundary. The real request-correlated
          // cancellation/disposition owner remains beneath the Action adapter.
          callMachineAction: input => callSocketRpc({ target: { kind: 'machine', id: input.machineId },
            method: input.method, params: input.request, content: { mode: 'plain' }, signal: input.signal,
            randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
              emitWithAck: async () => { issued.resolve(); return reply.promise; } } }),
        });
      const pending = execute({ actionId: 'mcp.servers.test', input: { t: 'byId', machineId: 'exact-machine',
        directory: '/project', serverId: 'server' }, context: { surface: 'cli', authority: 'present_user',
        serverId: 'home', actionCaller: { kind: 'host' }, signal: controller.signal } });
      await issued.promise;
      controller.abort();
      expect(await pending).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
      reply.resolve({ ok: true, result: { ok: true, toolCount: 1, durationMs: 1 } });
    });
  });
  it('retains an acknowledged process-test receipt but refuses probe content after Account retirement', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      for (const actionId of ['mcp.servers.test', 'mcp.found.list'] as const) {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const receipt = actionId === 'mcp.servers.test' ? { ok: true, toolCount: 1, durationMs: 1 }
          : { ok: true, servers: [] };
        const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
            callMachineAction: async input => {
              const result = await callSocketRpc({ target: { kind: 'machine', id: input.machineId },
                method: input.method, params: input.request, content: { mode: 'plain' },
                randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
                  emitWithAck: async () => ({ ok: true, result: receipt }) } });
              // The transport has consumed its genuine ACK before the Account
              // retires; private read content and effect receipts differ here.
              clearActiveAccountSettingsSnapshot();
              return result;
            },
          });
        const input = actionId === 'mcp.servers.test' ? { t: 'byId', machineId: 'exact-machine', directory: '/project', serverId: 'server' }
          : { machineId: 'exact-machine', directory: '/project' };
        expect(await execute({ actionId, input, context: { surface: 'cli', authority: 'present_user', serverId: 'home',
          actionCaller: { kind: 'host' } } })).toEqual(actionId === 'mcp.servers.test'
          ? { ok: true, result: receipt } : { ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
      }
    });
  });
});
