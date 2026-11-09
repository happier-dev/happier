import { describe, expect, it } from 'vitest';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from './serverActionsV1.js';
import { RpcError, RPC_ERROR_CODES } from '../../rpc/errors.js';
import { loadMcpServerCatalogV1, commitMcpServerCatalogMutationV1 } from './serverCatalogV1.js';
import type { McpServerCatalogV1 } from './serverRowsV1.js';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '../../connect/executeConfigurationActionV1.js';
import { ConnectedAccountDaemonControlResponseSchema } from '../../connect/connectedAccountDaemonRpcV1.js';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as service } from '../../connect/qualifiedConnectedAccountPersistence.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
const mode = { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
  pkce: 'required', outcomeReconciliation: 'none' } as const;
const custody = { occurrenceId: 'host-occurrence', sourceCustody: { kind: 'host' } } as const;

function harness(options: { online?: boolean; revokeFails?: boolean; conflict?: boolean; reconnect?: boolean;
  waitForRevoke?: Promise<void>; onRevoke?: () => void; revokeOutcomeUnknown?: boolean;
  clientMetadata?: boolean; beginConnectFailure?: Error; describeFailure?: Error; inconsistentConfigurationPeer?: boolean;
  waitingSignal?: AbortSignal; onRead?: () => void;
  httpsRefusal?: 'mcp_oauth_resource_requires_https' | 'mcp_oauth_endpoints_require_https' } = {}) {
  let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'server', name: 'linear', transport: 'http',
    remote: { url: options.httpsRefusal === 'mcp_oauth_resource_requires_https' ? 'http://resource.example.test/mcp' : 'https://resource.example.test/mcp', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }] };
  let revision = 9;
  let values: Record<string, unknown> = options.reconnect ? { issuer: 'https://issuer.example.test',
    registrations: { 'https://issuer.example.test': { clientId: 'cached-client' } }, stepUpScopes: ['tasks:write'] } : {};
  const commands: unknown[] = [];
  // RPC/persisted rows are system boundaries. Connected Services normalization,
  // configuration CAS interpretation, revoke and MCP orchestration remain real.
  const host: ConnectedServiceConfigurationActionHostV1 = {
    assertCurrent() {}, async request() { throw new Error('unexpected HTTP'); }, async mutatePurposeBindings() {},
    async resolveAgent() { return null; }, async resetQuota() {},
    async authenticationCommand(machineId, command) {
      commands.push({ machineId, command });
      if (command.operation === 'beginConnect' && options.beginConnectFailure) throw options.beginConnectFailure;
      if (command.operation === 'beginConnect') return { status: 'configurationRequired', attemptId: 'attempt',
        target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, missingFieldIds: ['serverId', 'resource'] };
      if (command.operation === 'continueConnect' || command.operation === 'beginReconnect') return { status: 'starting', attemptId: 'attempt' };
      if (command.operation === 'cancel') return { status: 'cancelled', attemptId: command.attemptId };
      if (command.operation === 'read' && options.waitingSignal) {
        options.onRead?.();
        return await new Promise<never>((_resolve, reject) => {
          const signal = options.waitingSignal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
      }
      if (command.operation === 'read' && options.httpsRefusal) return { status: 'rejected', attemptId: 'attempt',
        code: options.httpsRefusal, diagnostic: { code: options.httpsRefusal, severity: 'error' } };
      if (command.operation === 'read' && command.waitForProviderStart === true) return { status: 'awaitingOAuth', attemptId: 'attempt',
        authorizationUrl: `https://issuer.example.test/authorize?state=attempt.nonce${options.clientMetadata ? '&client_id=https%3A%2F%2Fapp.happier.dev%2Foauth%2Fmcp%2Fclient-metadata.json' : ''}`, callbackUrl: mode.callbackUrl, expiresAtMs: 5000 };
      throw new Error('Unexpected authentication command');
    },
    async controlCommand(machineId, command) {
      commands.push({ machineId, command });
      if (command.operation === 'describeService' && options.describeFailure) throw options.describeFailure;
      if (command.operation === 'describeService') return { status: 'described', service,
        descriptor: { id: service.localId, title: 'MCP sign-in', authentication: { defaultModeId: 'oauth', modes: [mode] } },
        accounts: options.revokeFails === undefined && !options.reconnect && !options.revokeOutcomeUnknown ? [] : [{ ref: { service, accountId: 'server' }, status: 'connected',
          authenticationModeId: 'oauth', configurationReady: true, configurationRevision: 'config-1', scopes: options.reconnect ? ['tasks:read'] : [],
          revisionSemantics: 'revisioned', credentialRevision: 'csr_1234567890123456789012' }],
        ...(command.requiredOperation ? { operationTransport: { kind: 'v4' as const } } : {}), ...custody };
      if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
        if (command.operation === 'replaceConfiguration') values = { ...command.values };
        return { status: command.operation === 'readConfiguration' ? 'configuration' : 'configurationCommitted',
          target: options.reconnect ? { kind: 'account', account: { service, accountId: 'server' }, modeId: 'oauth' }
            : { kind: 'attempt', attemptId: options.inconsistentConfigurationPeer ? 'another-attempt' : 'attempt', service, modeId: 'oauth' }, mode, ...custody,
          configuration: { status: 'ready', revision: command.operation === 'readConfiguration' ? options.reconnect ? 'config-before' : null : 'config-1',
            values, configuredSecretFieldIds: options.reconnect ? ['clientSecrets'] : [], missingFieldIds: [] } };
      }
      if (command.operation === 'revokeAccount') {
        options.onRevoke?.();
        await options.waitForRevoke;
        return options.revokeFails ? { status: 'unavailable', code: 'network_unavailable' }
          : options.revokeOutcomeUnknown ? { status: 'outcomeUnknown', account: command.account }
          : { status: 'revoked', account: command.account, remoteStatus: 'remoteUnsupported' };
      }
      throw new Error('Unexpected control command');
    },
  };
  const ports = {
    readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
    mutate: (change: Parameters<typeof commitMcpServerCatalogMutationV1>[0]['change'], expectedRevision: number | 'absent') =>
      commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null, writeCatalog: async candidate => {
        if (options.conflict || expectedRevision !== revision) return { status: 'conflict', revision };
        catalog = candidate.catalog;
        return { status: 'updated', revision: ++revision, cursor: revision };
      } }),
    machine: async () => { throw new Error('Unexpected MCP test'); },
    resolveAdministrationMachine: async () => options.online === false ? null : 'machine',
    describeConnectedService: async (machineId: string,
      command: Extract<import('../../connect/connectedAccountDaemonRpcV1.js').ConnectedAccountDaemonControlCommand, { operation: 'describeService' }>) =>
      ConnectedAccountDaemonControlResponseSchema.parse(await host.controlCommand!(machineId, command)),
    connectedServiceAction: Object.assign(async (request: Parameters<NonNullable<import('../../actions/executor/types.js').ActionExecutorDeps['connectedServiceAction']>>[0]) =>
      executeConnectedServiceConfigurationActionV1(host, request.actionId, request.input), {
        prepareInput: async (request: { input: unknown }) => prepareConnectedServiceRevokeInputV1(host, request.input),
      }),
  };
  return { execute: createMcpServerActionExecuteV1(ports), commands, read: () => ({ catalog, values }) };
}

describe('MCP sign-in through canonical Connected Services', () => {
  it.each([
    { stage: 'begin_connect', options: { beginConnectFailure: new Error('private transport diagnostic') }, code: 'mcp_sign_in_begin_connect_failed' },
    { stage: 'begin_connect', options: { beginConnectFailure: new RpcError('private transport diagnostic', RPC_ERROR_CODES.OUTCOME_UNKNOWN) }, code: RPC_ERROR_CODES.OUTCOME_UNKNOWN },
    { stage: 'service_description', options: { describeFailure: new Error('private transport diagnostic') }, code: 'mcp_sign_in_service_description_failed' },
    { stage: 'configuration_read', options: { inconsistentConfigurationPeer: true }, code: 'qualified_connected_accounts_inconsistent_peer' },
  ])('names the failed sign-in $stage without relabeling it as a catalog operation or exposing messages ($code)', async ({ stage, options, code }) => {
    const owner = harness(options);
    const result = await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' }, context })
      .catch(projectMcpServerActionFailureV1);
    expect(result).toMatchObject({ ok: false, errorCode: code, error: code, details: { stage } });
    expect(JSON.stringify(result)).not.toContain('private transport diagnostic');
    expect(owner.read().catalog.servers).toHaveLength(1);
  });
  it.each([false, true])('carries a supplied app only in secret configuration through the real Action composition (reconnect=%s)', async reconnect => {
    const owner = harness({ reconnect });
    const client = { clientId: 'person-app', clientSecret: crypto.randomUUID() };
    const result = await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server', client }, context });
    expect(result.ok).toBe(true);
    const replacement = owner.commands.find(item => (item as { command: { operation: string } }).command.operation === 'replaceConfiguration') as
      { command: { values: unknown; secretValues: Record<string, string> } } | undefined;
    expect(replacement !== undefined).toBe(true);
    expect(JSON.stringify(replacement?.command.values).includes(client.clientSecret)).toBe(false);
    expect(replacement?.command.secretValues.clientRegistration === JSON.stringify(client)).toBe(true);
    expect(JSON.stringify(result).includes(client.clientSecret)).toBe(false);
  });
  it('removes the server’s saved apps through configuration CAS before retrying automatic sign-in', async () => {
    const owner = harness({ reconnect: true });
    const result = await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server', client: null }, context });
    expect(result.ok).toBe(true);
    expect(owner.read().values.registrations).toEqual({});
    expect(owner.read().values.stepUpScopes).toEqual(['tasks:write']);
    expect(owner.commands).toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'replaceConfiguration',
      expectedRevision: 'config-before', secretValues: { clientSecrets: '{}', clientRegistration: 'null' } }) }));
  });
  it('tells the caller a supplied app is not needed when the host chose client metadata', async () => {
    const owner = harness({ clientMetadata: true });
    expect(await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server', client: { clientId: 'unused-app' } }, context }))
      .toMatchObject({ ok: true, result: { clientRegistration: 'not_needed' } });
  });
  it('admits the OAuth marker in the canonical Account catalog', async () => {
    const owner = harness();
    expect(await owner.execute({ actionId: 'mcp.servers.read', input: { serverId: 'server' }, context }))
      .toMatchObject({ ok: true, result: { status: 'present', authority: 'active', server: { remote: { auth: { kind: 'oauth' } } } } });
  });
  it('starts an account-specific attempt and configures only its draft before OAuth admission', async () => {
    const owner = harness();
    expect(await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server', stepUp: true }, context }))
      .toEqual({ ok: true, result: { attemptId: 'attempt', machineId: 'machine', expiresAtMs: 5000,
        authorizationUrl: 'https://issuer.example.test/authorize?state=attempt.nonce' } });
    expect(owner.read().values).toMatchObject({ serverId: 'server', resource: 'https://resource.example.test/mcp', stepUp: true });
    expect(owner.commands).toContainEqual({ machineId: 'machine', command: { operation: 'beginConnect',
      service, modeId: 'oauth' } });
    expect(owner.commands).toContainEqual({ machineId: undefined, command: { operation: 'continueConnect',
      attemptId: 'attempt', expectedConfigurationRevision: 'config-1' } });
    expect(owner.commands).not.toContainEqual(expect.objectContaining({ command: expect.objectContaining({ target: { kind: 'service' } }) }));
  });
  it('returns a typed no-machine refusal without creating an attempt', async () => {
    const owner = harness({ online: false });
    expect(await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' }, context }))
      .toEqual({ ok: false, errorCode: 'no_machine_online', error: 'no_machine_online' });
    expect(owner.commands).toEqual([]);
  });
  it.each(['mcp_oauth_resource_requires_https', 'mcp_oauth_endpoints_require_https'] as const)
    ('retains the host %s OAuth refusal without changing static HTTP catalog admission', async httpsRefusal => {
    const owner = harness({ httpsRefusal });
    expect(await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' }, context }))
      .toEqual({ ok: false, errorCode: httpsRefusal, error: httpsRefusal });
  });
  it('reconnects the exact grant with configuration CAS while retaining issuer registration and granted scopes', async () => {
    const owner = harness({ reconnect: true });
    expect(await owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server', stepUp: true }, context }))
      .toMatchObject({ ok: true, result: { attemptId: 'attempt', machineId: 'machine' } });
    expect(owner.read().values).toMatchObject({ issuer: 'https://issuer.example.test',
      registrations: { 'https://issuer.example.test': { clientId: 'cached-client' } },
      serverId: 'server', resource: 'https://resource.example.test/mcp', grantedScopes: ['tasks:read'], stepUpScopes: ['tasks:write'], stepUp: true });
    expect(owner.commands).toContainEqual({ machineId: 'machine', command: { operation: 'replaceConfiguration',
      target: { kind: 'account', account: { service, accountId: 'server' } }, expectedRevision: 'config-before',
      values: owner.read().values, secretValues: {} } });
    expect(owner.commands).toContainEqual({ machineId: 'machine', command: { operation: 'beginReconnect',
      account: { service, accountId: 'server' }, expectedConfigurationRevision: 'config-1' } });
  });
  it('cancels the owned attempt if the caller interrupts before provider start returns its URL', async () => {
    const controller = new AbortController();
    let readEntered = false;
    let enterRead!: () => void;
    const entered = new Promise<void>(resolve => { enterRead = resolve; });
    const owner = harness({ waitingSignal: controller.signal, onRead: () => { readEntered = true; enterRead(); } });
    const response = owner.execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' },
      context: { ...context, signal: controller.signal } }).catch((error: unknown) => error);
    await Promise.race([entered, response]);
    controller.abort();
    await response;
    expect(readEntered).toBe(true);
    expect(owner.commands).toContainEqual({ machineId: undefined, command: { operation: 'cancel', attemptId: 'attempt' } });
  });
  it('keeps a failed sign-out reachable and retries it through the existing grant owner before removal', async () => {
    const options = { revokeFails: true };
    const owner = harness(options);
    const request = { actionId: 'mcp.servers.delete' as const,
      input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context };
    expect(await owner.execute(request)).toEqual({ ok: false, errorCode: 'network_unavailable', error: 'network_unavailable' });
    expect(owner.read().catalog.servers).toHaveLength(1);
    options.revokeFails = false;
    const deleted = await owner.execute(request);
    expect(deleted).toMatchObject({ ok: true, result: { status: 'updated', revision: 10,
      signOut: { status: 'revoked', remoteStatus: 'remoteUnsupported' } } });
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.delete'].parse(deleted.ok ? deleted.result : null))
      .toMatchObject({ status: 'updated', signOut: { status: 'revoked' } });
    expect(owner.read().catalog.servers).toEqual([]);
    expect(owner.commands).toContainEqual({ machineId: 'machine', command: { operation: 'revokeAccount',
      account: { service, accountId: 'server' }, cleanupGroupReferences: true, expectedCredentialRevision: 'csr_1234567890123456789012' } });
  });
  it('retains the server while sign-out is pending and removes it only after the grant owner settles', async () => {
    let finish!: () => void;
    const waitForRevoke = new Promise<void>(resolve => { finish = resolve; });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const owner = harness({ revokeFails: false, waitForRevoke, onRevoke: enter });
    const response = owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context });
    await entered;
    const whilePending = owner.read().catalog.servers;
    finish();
    expect(await response).toMatchObject({ ok: true, result: { status: 'updated', signOut: { status: 'revoked' } } });
    expect(whilePending).toHaveLength(1);
    expect(owner.read().catalog.servers).toEqual([]);
  });
  it('keeps the server when sign-out has an unknown outcome instead of reporting a delete ACK', async () => {
    const owner = harness({ revokeOutcomeUnknown: true });
    expect(await owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context }))
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(owner.read().catalog.servers).toHaveLength(1);
  });
  it('retains the server when no administration machine can settle sign-out', async () => {
    const owner = harness({ online: false });
    expect(await owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context }))
      .toEqual({ ok: false, errorCode: 'no_machine_online', error: 'no_machine_online' });
    expect(owner.read().catalog.servers).toHaveLength(1);
    expect(owner.commands).toEqual([]);
  });
  it('never revokes for a known stale catalog revision', async () => {
    const owner = harness({ revokeFails: false });
    expect(await owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 8, removeBindings: true }, context }))
      .toMatchObject({ ok: true, result: { status: 'conflict', revision: 9 } });
    expect(owner.read().catalog.servers).toHaveLength(1);
    expect(owner.commands).toEqual([]);
  });
  it('preserves the final catalog CAS after sign-out settles', async () => {
    const owner = harness({ conflict: true, revokeFails: false });
    expect(await owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context }))
      .toMatchObject({ ok: true, result: { status: 'conflict' } });
    expect(owner.read().catalog.servers).toHaveLength(1);
    expect(owner.commands).toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'revokeAccount' }) }));
  });
  it('deletes a server without a grant without claiming sign-out is pending', async () => {
    const owner = harness();
    expect(await owner.execute({ actionId: 'mcp.servers.delete', input: { serverId: 'server', expectedRevision: 9, removeBindings: true }, context }))
      .toMatchObject({ ok: true, result: { status: 'updated', signOut: { status: 'not_connected' } } });
    expect(owner.commands).not.toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'revokeAccount' }) }));
  });
});
