import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createPersonalSavedSecretActionExecuteV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { McpServerCatalogRowReadResponseV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as service } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR } from '@/mcp/oauth/mcpSignInRuntime';
import { tryHandleMcpServerCliCommand } from './mcpServersArgv';
import { reloadConfiguration } from '@/configuration';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '../compiledCommands';
import { renderActionCliRootHelp } from '../rootCommand';

describe('MCP compiled CLI predecessor spellings', () => {
  function fixture(requireApproval = false, failedRead = false) {
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [] };
    let revision = 4; let ids = 0;
    const requests: { actionId: string; input: unknown }[] = [];
    const mcpServerAction = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => {
          if (failedRead) throw new Error('Unavailable HTTP transport');
          return McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision, content: { t: 'plain', v: catalog } });
        } }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      ruleWriteContext: () => ({ nowMs: 1, newId: () => `rule-${++ids}` }),
      async machine(request) {
        requests.push({ actionId: request.actionId, input: request.input });
        return { ok: true, servers: [], warnings: [{ provider: 'claude', code: 'read_failed', path: '/repo/.claude.json' }] };
      },
    });
    const personalSecret = createPersonalSavedSecretActionExecuteV1({
      list: async () => [
        { secretId: 'secret-id', name: 'WorkToken', kind: 'token', revision: 1 },
        { secretId: 'decoy-id', name: 'secret-id', kind: 'token', revision: 1 },
      ],
      async create() { throw new Error('MCP add must not create a Saved Secret'); },
      async update() { throw new Error('MCP add must not update a Saved Secret'); },
      async delete() { throw new Error('MCP add must not delete a Saved Secret'); },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), mcpServerAction,
      personalSavedSecretActionExecute: ({ actionId, input }) => personalSecret(actionId, input),
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: requireApproval ? {} : { 'mcp.servers.create': ['cli'], 'mcp.servers.duplicate': ['cli'] } }), context) });
    const output = captureConsoleJsonOutput<unknown>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { readCredentialsFn: async () => ({ token: 'test-token', encryption: null }),
      createExecutorFn: async () => ({ ...executor,
        execute: async (...args: Parameters<typeof executor.execute>) => {
          const schema = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[args[0] as keyof typeof MCP_SERVER_ACTION_INPUT_SCHEMAS_V1];
          if (schema) expect(schema.safeParse(args[1]).success).toBe(true);
          return executor.execute(...args);
        }, async resolveSessionTarget() { throw new Error('Unexpected session'); } }) };
    return { run: (argv: readonly string[]) => tryHandleMcpServerCliCommand({ argv, actionExecutionDeps: deps }),
      current: () => catalog, revision: () => revision, requests, output };
  }

  it.each([
    ['--name', 'fixture', '--transport', 'stdio', '--command', 'fixture-command', '--arg', '--stdio', '--arg', 'two words'],
    ['--name=fixture', '--transport=stdio', '--command=fixture-command', '--arg=--stdio', '--arg=two words'],
    ['fixture', '--command', 'fixture-command', '--arg', '--stdio', '--arg', 'two words'],
  ])('creates equivalent input through the compiled add leaf: %j', async (...args) => {
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'add', ...args, '--json'])).toBe(true);
    expect(owner.current().servers).toEqual([expect.objectContaining({ name: 'fixture', transport: 'stdio',
      stdio: { command: 'fixture-command', args: ['--stdio', 'two words'] }, env: {} })]);
    expect(owner.current().bindings).toEqual([expect.objectContaining({ serverId: owner.current().servers[0]?.id,
      target: { t: 'allMachines' }, enabled: true })]);
    expect(owner.revision()).toBe(5);
    const envelope = owner.output.json() as { data: unknown };
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].safeParse(envelope.data).success).toBe(true);
  });

  it('binds remote headers and environment through metadata without resolving secret bytes', async () => {
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'add', 'remote', '--transport', 'http', '--url', 'https://mcp.example.test',
      '--env', 'TOKEN=secret:WorkToken', '--env', 'LITERAL=text:secret:not-a-reference',
      '--header', 'Authorization=secret:secret-id', '--json'])).toBe(true);
    expect(owner.current().servers).toEqual([expect.objectContaining({ name: 'remote', transport: 'http',
      remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('secret-id') } } },
      env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('secret-id') }, LITERAL: { t: 'literal', v: 'secret:not-a-reference' } },
    })]);
    expect(owner.revision()).toBe(5);
  });

  it('duplicates a named server through the compiled semantic leaf and prints only its new identity', async () => {
    const owner = fixture();
    await owner.run(['mcp', 'servers', 'add', 'issues', '--command', 'fixture-command', '--json']);
    expect(await owner.run(['mcp', 'servers', 'duplicate', 'issues', '--json'])).toBe(true);
    const copy = owner.current().servers[1];
    expect(copy).toMatchObject({ name: 'issues_copy', stdio: { command: 'fixture-command', args: [] } });
    expect(copy?.id).not.toBe(owner.current().servers[0]?.id);
    expect(owner.current().bindings.filter(rule => rule.serverId === copy?.id))
      .toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
    expect(owner.output.json()).toMatchObject({ ok: true, data: { serverId: copy?.id } });
  });

  it.each(['--server-id=not-a-selected-home', '--'])('keeps the program argument %s out of Home routing and JSON mode', async argument => {
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'add', 'literal', '--command', 'fixture-command',
      '--arg', argument, '--json'])).toBe(true);
    expect(owner.current().servers).toEqual([expect.objectContaining({ name: 'literal',
      stdio: { command: 'fixture-command', args: [argument] } })]);
    expect(owner.output.json()).toMatchObject({ ok: true });
  });

  it.each([
    ['mcp', 'servers', 'detect', '--provider', 'claude', '--provider', 'codex', '--dir', '/repo', '--machine', 'machine'],
    ['mcp', 'servers', 'detect', '--provider=claude', '--provider=codex', '--dir=/repo', '--machine=machine'],
    ['mcp', 'found', '--providers', 'claude', '--providers', 'codex', '--directory', '/repo', '--machine-id', 'machine'],
  ])('dispatches equivalent discovery input through the compiled Found leaf: %j', async (...argv) => {
    const owner = fixture();
    expect(await owner.run([...argv, '--json'])).toBe(true);
    expect(owner.requests).toEqual([{ actionId: 'mcp.found.list', input: {
      machineId: 'machine', providers: ['claude', 'codex'], directory: '/repo' } }]);
    // The CLI envelope lifts the canonical response's ok field into its own ok.
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.found.list'].safeParse({ ok: true,
      ...(owner.output.json() as { data: Record<string, unknown> }).data }).success).toBe(true);
  });

  it.each([[], ['--']])('defaults the 0.2 detect target through the shared Machine owner: %j', async (...tail) => {
    terminal.inventory.mockResolvedValue({ data: [{ id: 'machine', active: true, revokedAt: null, replacedByMachineId: null }] });
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'detect', '--provider', 'claude', '--dir', '/repo', '--json', ...tail])).toBe(true);
    expect(owner.requests).toEqual([{ actionId: 'mcp.found.list', input: {
      machineId: 'machine', providers: ['claude'], directory: '/repo' } }]);
  });

  it.each([[], ['--dir', '/repo'], ['--dir=/repo']])('keeps the 0.2 list spelling Account-owned: %j', async (...args) => {
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'list', ...args, '--json'])).toBe(true);
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].safeParse((owner.output.json() as { data: unknown }).data).success).toBe(true);
    expect(owner.requests).toEqual([]);
  });

  it('keeps approval on the create spec and rejects malformed caller input before mutation', async () => {
    const owner = fixture(true);
    expect(await owner.run(['mcp', 'servers', 'add', 'fixture', '--command', 'fixture-command', '--json'])).toBe(true);
    expect(owner.current().servers).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(await owner.run(['mcp', 'servers', 'add', 'fixture', '--unknown', 'bad', '--json'])).toBe(true);
    expect(owner.current().servers).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps catalog read failures in the requested JSON envelope without a create', async () => {
    const owner = fixture(false, true);
    expect(await owner.run(['mcp', 'servers', 'add', 'fixture', '--command', 'fixture-command', '--json'])).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(owner.current().servers).toEqual([]);
    expect(owner.output.logs.length).toBeGreaterThan(0);
    expect(owner.output.json()).toMatchObject({ ok: false, error: { code: 'mcp_catalog_unavailable' } });
  });

  it('derives servers help and retired-probe removal from the compiled Action catalog', () => {
    const commands = listCompiledActionCliCommands();
    expect(findCompiledActionCliCommand(['mcp', 'servers', 'add'], commands)?.actionId).toBe('mcp.servers.create');
    expect(findCompiledActionCliCommand(['mcp', 'servers', 'detect'], commands)?.actionId).toBe('mcp.found.list');
    expect(commands.some(command => String(command.actionId) === 'mcp.servers.probe')).toBe(false);
    const help = renderActionCliRootHelp('mcp', ['mcp', 'servers']);
    expect(help).toContain('happier mcp servers add');
    expect(help).toContain('happier mcp servers tools');
    expect(help).not.toContain('happier mcp serve ');
  });
});

const terminal = vi.hoisted(() => ({ prompt: vi.fn(), rpc: vi.fn(), inventory: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const original = await importOriginal<typeof import('axios')>();
  return { ...original, default: { ...original.default, get: terminal.inventory } };
});
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(), promptInput: terminal.prompt,
}));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: terminal.rpc,
}));
afterEach(() => { terminal.prompt.mockReset(); terminal.inventory.mockReset(); vi.restoreAllMocks();
  vi.unstubAllEnvs(); reloadConfiguration(); process.exitCode = 0; });

describe('MCP compiled CLI tools', () => {
  function fixture(changed?: 'account' | 'home', conflict = false, requireApproval = false) {
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [
      { id: 'decoy', name: 'server-id', transport: 'stdio', stdio: { command: 'fixture', args: [] },
        env: {}, createdAt: 1, updatedAt: 1 },
      { id: 'server-id', name: 'fixture', transport: 'stdio', stdio: { command: 'fixture', args: [] },
        env: {}, createdAt: 1, updatedAt: 1, tools: { default: 'ask', overrides: { keep: 'off', read: 'ask' } } },
    ] };
    let revision = 9;
    let reads = 0;
    const writes: number[] = [];
    // Only row persistence and credential reads are replaced. Loader, compiled
    // CLI, Action executor, mutation reducer and catalog CAS stay real.
    const mcpServerAction = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => {
        if (changed === 'home') { vi.stubEnv('HAPPIER_SERVER_URL', 'https://changed-home.example.test'); reloadConfiguration(); }
        return McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision, content: { t: 'plain', v: catalog } });
      } }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => {
          if (conflict || candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          writes.push(expectedRevision); catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      async machine() { throw new Error('Tools are Account-owned'); },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), mcpServerAction,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: requireApproval ? {} : { 'mcp.servers.tools.set': ['cli'] } }), context) });
    const output = captureConsoleJsonOutput<unknown>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { readCredentialsFn: async () => ({ token: changed === 'account' && reads++ > 0 ? 'changed-token' : 'test-token', encryption: null }),
      createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected session'); } }) };
    return { run: (argv: readonly string[]) => tryHandleMcpServerCliCommand({ argv, actionExecutionDeps: deps }),
      current: () => catalog, revision: () => revision, writes, output };
  }

  it('resolves id before name and patches only named tools through the real catalog CAS', async () => {
    const owner = fixture();
    expect(await owner.run(['mcp', 'servers', 'tools', 'server-id', '--json'])).toBe(true);
    expect(owner.output.json()).toMatchObject({ ok: true, data: { serverId: 'server-id' } });
    expect(owner.writes).toEqual([]);
    for (const setting of ['off', 'ask', 'allow', 'inherit']) {
      expect(await owner.run(['mcp', 'servers', 'tools', 'server-id', 'set', 'read', setting, '--json'])).toBe(true);
      expect(owner.current().servers[0]?.tools).toBeUndefined();
      expect(owner.current().servers[1]?.tools).toEqual({ default: 'ask',
        overrides: setting === 'inherit' ? { keep: 'off' } : { keep: 'off', read: setting } });
    }
    expect(owner.writes).toEqual([9, 10, 11, 12]);
  });

  it.each([['ask', 'ask'], ['read-only', 'allow_read_only'], ['all', 'allow_all']] as const)
    ('maps the friendly default %s through the compiled caller binder', async (friendly, expected) => {
      const owner = fixture();
      expect(await owner.run(['mcp', 'servers', 'tools', 'fixture', 'default', friendly, '--json'])).toBe(true);
      expect(owner.current().servers[1]?.tools).toEqual({ default: expected, overrides: { keep: 'off', read: 'ask' } });
      expect(owner.revision()).toBe(10);
    });

  it.each(['account', 'home'] as const)('refuses a changed captured %s before mutation', async changed => {
    const owner = fixture(changed);
    expect(await owner.run(['mcp', 'servers', 'tools', 'fixture', 'set', 'read', 'allow', '--json'])).toBe(true);
    expect(owner.writes).toEqual([]);
    expect(owner.revision()).toBe(9);
    expect(process.exitCode).toBe(1);
  });

  it('preserves CAS conflict refusal and normal compiler argument validation', async () => {
    const owner = fixture(undefined, true);
    expect(await owner.run(['mcp', 'servers', 'tools', 'fixture', 'set', 'read', 'allow', '--json'])).toBe(true);
    expect(owner.writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    for (const args of [['set', 'read', 'invalid'], ['default', 'invalid'], ['set', 'read', 'allow', 'extra']]) {
      process.exitCode = 0;
      expect(await owner.run(['mcp', 'servers', 'tools', 'fixture', ...args, '--json'])).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(owner.writes).toEqual([]);
    }
    expect(owner.revision()).toBe(9);
  });

  it('leaves approval admission at the compiled Action and keeps raw whole-input paths', async () => {
    const owner = fixture(undefined, false, true);
    expect(await owner.run(['mcp', 'servers', 'tools', 'fixture', 'set', 'read', 'allow', '--json'])).toBe(true);
    expect(owner.writes).toEqual([]);
    expect(owner.revision()).toBe(9);
    process.exitCode = 0;
    expect(await owner.run(['mcp', 'servers', 'tools', 'list', '--input-json={"serverId":"server-id"}', '--json'])).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(owner.writes).toEqual([]);
  });
});

describe('MCP compiled CLI Test', () => {
  it.each([
    { argv: ['mcp', 'servers', 'test', '--mcp-server', 'fixture', '--dir', '/repo', '--machine-id', 'machine', '--json'], switchedHome: false, offline: false },
    { argv: ['mcp', 'servers', 'test', 'fixture', '--directory', '/repo', '--machine-id', 'machine', '--json'], switchedHome: false, offline: false },
    { argv: ['mcp', 'servers', 'test', 'fixture', '--directory', '/repo', '--machine-id', 'machine', '--json'], switchedHome: true, offline: false },
    { argv: ['mcp', 'servers', 'test', 'fixture', '--directory', '/repo', '--machine-id', 'machine', '--json'], switchedHome: false, offline: true },
  ])('preserves captured Home and explicitly requested Test (changed=$switchedHome, offline=$offline)', async ({ argv, switchedHome, offline }) => {
    const requests: unknown[] = [];
    terminal.inventory.mockResolvedValue({ data: [{ id: 'machine', active: !offline, revokedAt: null, replacedByMachineId: null }] });
    const mcpServerAction = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => {
        if (switchedHome) { vi.stubEnv('HAPPIER_SERVER_URL', 'https://changed-home.example.test'); reloadConfiguration(); }
        return { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server-id', name: 'fixture', transport: 'stdio',
          stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] } } }; } }),
      async mutate() { throw new Error('Unexpected catalog write'); },
      async machine(request) { requests.push(request); return { ok: true, toolCount: 1, toolNamesSample: ['echo'], durationMs: 1 }; },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), mcpServerAction,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'mcp.servers.test': ['cli'] } }), context) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await tryHandleMcpServerCliCommand({ argv, actionExecutionDeps: {
      readCredentialsFn: async () => ({ token: 'test-token', encryption: null }),
      createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected session'); } }),
    } })).toBe(true);
    if (switchedHome) {
      expect(requests).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(terminal.inventory.mock.calls.some(args => String(args[0]).includes('changed-home.example.test'))).toBe(false);
      return;
    }
    expect(requests).toEqual([expect.objectContaining({ actionId: 'mcp.servers.test', machineId: 'machine',
      input: { t: 'byId', machineId: 'machine', directory: '/repo', serverId: 'server-id' } })]);
  });
});

describe('MCP compiled CLI sign-in journey', () => {
  const suppliedSecret = crypto.randomUUID();
  it.each([
    { name: 'positional server name', argv: ['mcp', 'servers', 'sign-in', 'linear', '--no-open'], switched: false },
    { name: 'flags before the positional name', argv: ['mcp', 'servers', 'sign-in', '--step-up', 'linear', '--no-open'], switched: false },
    { name: 'Account changes after catalog read', argv: ['mcp', 'servers', 'sign-in', 'linear', '--no-open'], switched: true },
    { name: 'sign-out through existing revoke', argv: ['mcp', 'servers', 'sign-out', 'linear'], switched: false },
    { name: 'sign-out on an explicitly selected Machine with stale presence', argv: ['mcp', 'servers', 'sign-out', 'linear', '--machine-id', 'selected-machine'], switched: false },
    { name: 'an exact id cannot be shadowed by another display name', argv: ['mcp', 'servers', 'sign-in', 'server-id', '--no-open'], switched: false },
    { name: 'a supplied app through the compiled Action', argv: ['mcp', 'servers', 'sign-in', 'linear', '--client-id', 'person-app', '--client-secret', suppliedSecret, '--no-open'], switched: false },
    { name: 'canonical JSON app replacement with terminal continuation', argv: ['mcp', 'servers', 'sign-in', '--input-json', JSON.stringify({ serverId: 'server-id', client: { clientId: 'person-app', clientSecret: suppliedSecret } }), '--no-open'], switched: false },
    { name: 'canonical JSON app removal', argv: ['mcp', 'servers', 'sign-in', '--input-json={"serverId":"server-id","client":null}', '--no-open'], switched: false },
    { name: 'canonical JSON app removal with JSON output', argv: ['mcp', 'servers', 'sign-in', '--input-json={"serverId":"server-id","client":null}', '--json'], switched: false },
    { name: 'canonical JSON with a friendly server-name overlay', argv: ['mcp', 'servers', 'sign-in', '--input-json={"client":null}', 'linear', '--no-open'], switched: false },
    { name: 'canonical JSON sign-out on its specified Machine', argv: ['mcp', 'servers', 'sign-out', '--input-json', JSON.stringify({ machineId: 'selected-machine', account: { service, accountId: 'server-id' }, cleanupGroupReferences: true })], switched: false },
  ])('resolves through the catalog Action and preserves the captured Account: $name', async ({ argv, switched }) => {
    const commands: unknown[] = [];
    const signOut = argv[2] === 'sign-out';
    terminal.inventory.mockResolvedValue({ data: [{ id: 'machine', active: true, revokedAt: null, replacedByMachineId: null },
      { id: 'selected-machine', active: false, activeAt: 1, revokedAt: null, replacedByMachineId: null }] });
    const descriptor = MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR;
    const mode = descriptor.authentication.modes.find(mode => mode.id === 'oauth');
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected host MCP OAuth mode');
    let configurationValues: Record<string, unknown> = {};
    let suppliedAppAdmitted = false;
    let removedAppAdmitted = false;
    const described = { status: 'described', service, descriptor, occurrenceId: 'host-generation', sourceCustody: { kind: 'host' },
      accounts: signOut ? [{ ref: { service, accountId: 'server-id' }, status: 'connected', authenticationModeId: 'oauth',
        configurationReady: true, configurationRevision: 'config-1', scopes: [], revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012' }] : [], operationTransport: { kind: 'v4' } };
    terminal.rpc.mockResolvedValue(described);
    const host: ConnectedServiceConfigurationActionHostV1 = { assertCurrent() {}, async request() { throw new Error('Unexpected HTTP'); },
      async mutatePurposeBindings() {}, async resolveAgent() { return null; }, async resetQuota() {},
      async authenticationCommand(machineId, command) {
        commands.push({ machineId, command });
        if (command.operation === 'beginConnect') return { status: 'configurationRequired', attemptId: 'attempt',
          target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, missingFieldIds: ['serverId', 'resource'] };
        if (command.operation === 'continueConnect') return { status: 'starting', attemptId: 'attempt' };
        if (command.operation === 'read' && command.waitForProviderStart) return { status: 'awaitingOAuth', attemptId: 'attempt',
          authorizationUrl: 'https://issuer.example.test/authorize?state=attempt.nonce', callbackUrl: mode.callbackUrl, expiresAtMs: 5000 };
        if (command.operation === 'completeOAuth') return { status: 'connected', attemptId: 'attempt', account: { service, accountId: 'server-id' } };
        if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'attempt' };
        throw new Error('Unexpected authentication');
      },
      async controlCommand(machineId, command) {
        if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
          if (command.operation === 'replaceConfiguration') {
            configurationValues = { ...command.values };
            suppliedAppAdmitted = command.secretValues.clientRegistration === JSON.stringify({ clientId: 'person-app', clientSecret: suppliedSecret });
            removedAppAdmitted = command.secretValues.clientRegistration === 'null' && command.secretValues.clientSecrets === '{}';
          }
          return { status: command.operation === 'readConfiguration' ? 'configuration' : 'configurationCommitted',
            target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, mode,
            occurrenceId: described.occurrenceId, sourceCustody: described.sourceCustody,
            configuration: { status: 'ready', revision: command.operation === 'readConfiguration' ? null : 'config-1',
              values: configurationValues, configuredSecretFieldIds: [], missingFieldIds: [] } };
        }
        if (command.operation === 'revokeAccount') {
          commands.push({ machineId, command });
          return { status: 'revoked', account: command.account, remoteStatus: 'remoteUnsupported' };
        }
        return described;
      },
    };
    const connectedServiceAction = Object.assign(({ actionId, input }: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['connectedServiceAction']>>[0]) =>
      executeConnectedServiceConfigurationActionV1(host, actionId, input), {
      prepareInput: async (request: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['connectedServiceAction']>>[0]) =>
        request.actionId === 'connectedServices.accounts.revoke' ? await prepareConnectedServiceRevokeInputV1(host, request.input) : request.input,
    });
    const mcpServerAction = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'decoy-server', name: 'server-id', transport: 'http',
          remote: { url: 'https://decoy.example.test/mcp', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 },
          { id: 'server-id', name: 'linear', transport: 'http',
          remote: { url: 'https://resource.example.test/mcp', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }] } } }) }),
      async mutate() { throw new Error('Unexpected catalog write'); }, async machine() { throw new Error('Unexpected MCP test'); },
      resolveAdministrationMachine: async () => 'machine', describeConnectedService: async () => described, connectedServiceAction,
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), mcpServerAction, connectedServiceAction,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'mcp.servers.signIn.start': ['cli'],
          'connectedServices.authentication.completeOAuth': ['cli'], 'connectedServices.authentication.cancel': ['cli'],
          'connectedServices.accounts.revoke': ['cli'] } }), context) });
    terminal.prompt.mockResolvedValue('https://app.happier.dev/oauth/mcp/callback?code=returned-code&state=attempt.nonce&iss=https%3A%2F%2Fissuer.example.test');
    const jsonOutput = argv.includes('--json') ? captureConsoleJsonOutput<unknown>() : null;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let credentialReads = 0;
    const handled = await tryHandleMcpServerCliCommand({ argv,
      actionExecutionDeps: { readCredentialsFn: async () => ({ token: switched && credentialReads++ > 0 ? 'another-account-token' : 'test-token', encryption: null }),
        createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected session'); } }) } });
    expect(handled).toBe(true);
    if (switched) {
      expect(commands).not.toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'beginConnect' }) }));
      expect(process.exitCode).toBe(1);
      return;
    }
    if (signOut) {
      expect(commands).toEqual([{ machineId: argv.includes('--machine-id') || argv.includes('--input-json') ? 'selected-machine' : 'machine', command: { operation: 'revokeAccount', account: { service, accountId: 'server-id' },
        cleanupGroupReferences: true, expectedCredentialRevision: 'csr_1234567890123456789012' } }]);
      expect(terminal.prompt).not.toHaveBeenCalled();
      return;
    }
    if (argv.includes('--json')) {
      expect(removedAppAdmitted).toBe(true);
      expect(terminal.prompt).not.toHaveBeenCalled();
      expect(commands).not.toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'completeOAuth' }) }));
      expect(jsonOutput?.json()).toMatchObject({ ok: true, data: { attemptId: 'attempt', machineId: 'machine',
        authorizationUrl: 'https://issuer.example.test/authorize?state=attempt.nonce' } });
      return;
    }
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'completeOAuth', attemptId: 'attempt',
      completion: { code: 'returned-code', state: 'attempt.nonce', callbackUrl: mode.callbackUrl, iss: 'https://issuer.example.test' } } });
    expect(configurationValues).toMatchObject({ serverId: 'server-id', resource: 'https://resource.example.test/mcp', stepUp: argv.includes('--step-up') });
    if (argv.includes('--client-id') || argv.some(value => value.includes('person-app'))) {
      expect(suppliedAppAdmitted).toBe(true);
      expect(JSON.stringify(configurationValues).includes(suppliedSecret)).toBe(false);
      expect(JSON.stringify(log.mock.calls).includes(suppliedSecret)).toBe(false);
    }
    if (argv.some(value => value.includes('"client":null'))) {
      expect(removedAppAdmitted).toBe(true);
      expect(configurationValues.registrations).toEqual({});
    }
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'read', attemptId: 'attempt', waitForProviderStart: true } });
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'cancel', attemptId: 'attempt' } });
    expect(log.mock.calls.some(args => args.some(value => typeof value === 'string' && value.includes('https://issuer.example.test/authorize')))).toBe(true);
  });
});
