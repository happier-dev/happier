import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';

import { createExternalMcpServer } from './createExternalMcpServer';

async function listTools(actions: Record<string, unknown>) {
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions }));
  const { mcp, toolNames } = createExternalMcpServer({ credentials: { token: 'exposure-fixture', encryption: null } });
  const client = new Client({ name: 'standalone-exposure-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      listed: (await client.request({ method: 'tools/list' }, ListToolsResultSchema)).tools.map(tool => tool.name).sort(),
      registered: [...toolNames].sort(),
    };
  } finally {
    await client.close();
    await mcp.close();
  }
}

// The full production Action catalog is the scale fixture. Adding ordinary
// Actions must not grow the default list compiled by every external MCP client.
const defaultToolNames = [
  'action_execute', 'action_options_resolve', 'action_spec_get', 'action_spec_search',
  'change_title', 'execution_run_get', 'execution_run_list', 'execution_run_wait',
  'plugins_reload', 'session_board_get', 'session_board_item_remove', 'session_board_item_upsert', 'skills_read', 'watch',
].sort();

describe('standalone MCP Action exposure', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lists only the shared direct defaults rather than the full Action inventory', async () => {
    const { listed, registered } = await listTools({});
    expect(listed).toEqual(defaultToolNames);
    expect(registered).toEqual(listed);
  });

  it('adds exactly one Action for an Account direct override', async () => {
    expect((await listTools({ 'session.status.get': { toolExposureModes: { mcp: 'direct' } } })).listed)
      .toEqual([...defaultToolNames, 'session_status_get'].sort());
  });

  it('removes an allow-listed direct Action for an Account discoverable-only override', async () => {
    expect((await listTools({ 'execution.run.list': { toolExposureModes: { mcp: 'discoverable_only' } } })).listed)
      .toEqual(defaultToolNames.filter(name => name !== 'execution_run_list'));
  });

  it.each(['stored_session', 'api_token'] as const)('keeps standalone %s Session creation authoring terminal for named and generic tools', async credentialProvenance => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1,
      actions: { 'session.spawn_new': { toolExposureModes: { mcp: 'direct' } } } }));
    const requests: unknown[] = [];
    const unexpected: string[] = [];
    const result = { type: 'success', disposition: 'created', sessionId: 'c1234567890123456789012345',
      executionTarget: { serverId: configuration.activeServerId, machineId: 'selected-machine' },
      organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    // Home HTTP is the only substituted boundary. The actual standalone factory,
    // SDK tools/list and tools/call, bridge, schema admission and PAT projection run unchanged.
    const home = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/actions/session.spawn_new') {
        requests.push(body);
        response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new',
          requestId: body && typeof body === 'object' ? Reflect.get(body, 'requestId') : undefined,
          execution: { ok: true, result } }));
      } else {
        unexpected.push(request.url ?? '');
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unavailable' }));
      }
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const token = credentialProvenance === 'api_token'
      ? `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}`
      : `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({
      credentials: { token, encryption: null, credentialProvenance }, daemonControlTarget: null,
      machineId: 'selected-machine',
    }));
    const client = new Client({ name: 'standalone-spawn-authoring', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const spawn = (await client.listTools()).tools.find(tool => tool.name === 'session_spawn_new');
      expect(spawn).toBeDefined();
      const input = { creationKey: 'standalone-authoring', executionTarget: result.executionTarget,
        directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
      if (credentialProvenance === 'api_token') {
        // Exercise the credentialed ingress itself, beyond the external factory's
        // former validator. MCP admission must happen before API projection can
        // discard terminal-only restrictions or their typed repair details.
        const bridge = createActionToolExecutorBridge({ surface: 'mcp', executor: createCliActionExecutorFromCredentials({
          credentials: { token, encryption: null, credentialProvenance }, serverId: configuration.activeServerId,
          serverApiUrl: endpoint, machineId: 'selected-machine',
        }) });
        expect(await bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new', input }, 'cli-global'))
          .toEqual({ ok: true, result });
        const beforeInvalid = requests.length;
        expect(await bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new',
          input: { ...input, observeSessionCommit: true } }, 'cli-global'))
          .toMatchObject({ ok: false, errorCode: 'invalid_parameters',
            details: { issues: [{ code: 'unrecognized_keys', path: [] }] } });
        expect(requests).toHaveLength(beforeInvalid);
      }
      for (const toolName of ['session_spawn_new', 'action_execute']) {
        const invoke = async (value: unknown) => CallToolResultSchema.parse(await client.callTool({ name: toolName,
          arguments: toolName === 'action_execute' ? { actionId: 'session.spawn_new', input: value } : value as Record<string, unknown> }));
        const ordinary = await invoke(input);
        const text = ordinary.content.find(part => part.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Missing ordinary authoring result');
        if (credentialProvenance === 'api_token') {
          expect(ordinary.isError, text.text).not.toBe(true);
          expect(JSON.parse(text.text)).toEqual(result);
        } else {
          // The default unbound Account MCP has no creation namespace. Keep
          // that existing refusal; this task does not grant it person authority.
          expect(ordinary.isError).toBe(true);
          expect(JSON.parse(text.text)).toMatchObject({ errorCode: 'invalid_parameters' });
        }
        const callsBeforeObserver = requests.length;
        const observed = await invoke({ ...input, observeSessionCommit: true });
        expect.soft(observed.isError).toBe(true);
        const rejection = observed.content.find(part => part.type === 'text');
        if (!rejection || rejection.type !== 'text') throw new Error('Missing authoring refusal');
        expect.soft(JSON.parse(rejection.text)).toMatchObject({ errorCode: 'invalid_parameters',
          details: { issues: [{ code: 'unrecognized_keys', path: [] }] } });
        expect.soft(requests).toHaveLength(callsBeforeObserver);
      }
      expect.soft(spawn?.inputSchema.properties).not.toHaveProperty('observeSessionCommit');
      expect.soft(requests).toHaveLength(credentialProvenance === 'api_token' ? 3 : 0);
      expect(unexpected).toEqual([]);
    } finally {
      await client.close();
      await mcp.close();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });
});
