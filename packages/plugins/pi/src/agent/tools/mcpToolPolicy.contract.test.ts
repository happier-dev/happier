import { runAgentMcpToolPolicyContract } from '@happier-dev/plugin-sdk/testing';
import { createPiMcpToolPolicyContractFixture } from './mcpToolPolicy.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent, AgentExecutionRunRuntime, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { readSessionCapabilityNoticeV1, SessionCapabilityNoticeV1Schema } from '@happier-dev/protocol';

runAgentMcpToolPolicyContract(createPiMcpToolPolicyContractFixture());

it('publishes complete native delivery and zero calls for the delivered unused binding', async () => {
  const input = createPiMcpToolPolicyContractFixture();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mcp-delivery-contract-'));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    runtime = await input.openSession({ kind: 'create', sessionId: 'pi-mcp-delivery', cwd,
      configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} },
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])),
    });
    const result = await input.invokeTool(runtime, { server: 'a', tool: 'echo', arguments: {}, approvalScope: 'once' });
    expect(result.outcome).toBe('completed');
    const usage = input.observeLaunch().runtimeEvents.filter(event => event.kind === 'mcp-tool-usage');
    expect(usage).toMatchObject([{ coverage: 'complete', servers: [
      { serverName: 'a', toolCallCount: 1, schemaBytes: null },
      { serverName: 'b', toolCallCount: 0, schemaBytes: null },
    ] }]);
    expect(usage).toHaveLength(1);
  } finally {
    try { await runtime?.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});

it('keeps healthy MCP callable after optional initialize failure through real Pi startup and notice publication', async () => {
  const stage = 'initialize';
  const input = createPiMcpToolPolicyContractFixture({ brokenServer: stage });
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-optional-mcp-contract-'));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    runtime = await input.openSession({ kind: 'create', sessionId: 'pi-optional-mcp', cwd,
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])),
      mcpServersStrictMode: false,
    });
    await expect.poll(() => input.observeCapabilityNotices()).toHaveLength(1);
    const notice = readSessionCapabilityNoticeV1(input.observeCapabilityNotices()[0]);
    expect(SessionCapabilityNoticeV1Schema.parse(notice)).toEqual({ v: 1,
      items: [{ kind: 'mcp_server', name: 'broken', code: `mcp_${stage}_failed` }] });
    expect(JSON.stringify(input.observeCapabilityNotices())).not.toContain('private-failure-sentinel');
    // Optional native open precedes catalog discovery. Query the real installed
    // Pi's public tool inventory before asking the synthetic model to call it.
    await vi.waitFor(async () => expect(await input.readNativeTools()).toContain('mcp__a__echo'), { timeout: 30_000 });
    const result = await input.invokeTool(runtime, { server: 'a', tool: 'echo', arguments: {}, approvalScope: 'once' });
    expect(result.outcome).toBe('completed');
    expect(input.observeServerCalls()).toEqual([expect.objectContaining({ server: 'a', privateTokenDelivered: true })]);
  } finally {
    try { await runtime?.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});

it.each(['session', 'run'] as const)('refuses strict MCP startup through the actual Pi %s leaf', async kind => {
  const input = createPiMcpToolPolicyContractFixture({ brokenServer: 'initialize' });
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-strict-mcp-contract-'));
  const openedRuntimes: (AgentSessionRuntime | AgentExecutionRunRuntime)[] = [];
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    const mcpServers = Object.fromEntries(fixture.servers.map(server => [server.key, server.config]));
    const opening = kind === 'session'
      ? input.openSession({ kind: 'create', sessionId: 'pi-strict-mcp', cwd, mcpServers, mcpServersStrictMode: true })
      : input.openRun({ kind: 'create', runId: 'pi-strict-mcp', cwd,
      profile: { pluginId: 'fixture', localId: 'profile' }, input: { text: 'unreachable' },
      mcpServers, mcpServersStrictMode: true });
    await expect(opening.then(runtime => { openedRuntimes.push(runtime); return runtime; })).rejects.toThrow(/MCP/);
    expect(input.observeServerCalls()).toEqual([]);
  } finally {
    for (const runtime of openedRuntimes) await runtime.dispose();
    await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true });
  }
});

it('rejects a miswired native MCP approval correlation before host approval or server receipt', async () => {
  const input = createPiMcpToolPolicyContractFixture({ corruptNativeApprovalCorrelation: true });
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-miswired-mcp-'));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    const policy = { a: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } },
      b: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } } };
    runtime = await input.openSession({ kind: 'create', sessionId: 'pi-miswired-mcp', cwd,
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])), mcpToolPolicy: policy });
    const invocation = await input.invokeTool(runtime, { server: 'a', tool: 'echo', arguments: {}, approvalScope: 'once' });
    expect(invocation).toEqual({ outcome: 'denied', permissions: [] });
    expect(input.fixtureServer.observeCalls()).toEqual([]);
  } finally {
    try { await runtime?.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});

it.each(['ask', 'off', 'allow'] as const)('delivers %s Run MCP through the same real extension and host permission handler', async setting => {
  const input = createPiMcpToolPolicyContractFixture();
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-run-mcp-contract-'));
  const runtimes: AgentExecutionRunRuntime[] = [];
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    const projection = { a: { unlisted: 'ask' as const, tools: { echo: setting === 'off' ? 'off' as const : 'ask' as const } },
      b: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } } };
    await input.fixtureServer.setPolicy({ permissionMode: 'default', settings: { a: setting, b: 'ask' }, projection,
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} } });
    const beforeCalls = input.fixtureServer.observeCalls().length;
    const beforePermissions = input.observePermissions().length;
    const runtime = await input.openRun({ kind: 'create', runId: `pi-mcp-${setting}`, cwd,
      profile: { pluginId: 'fixture', localId: 'profile' },
      input: { text: 'happier-fixture:{"name":"mcp__a__echo","args":{}}' },
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])), mcpToolPolicy: projection });
    runtimes.push(runtime);
    await new Promise<void>((resolve, reject) => runtime.watch(event => {
      if (event.kind === 'run-complete') resolve();
      if (event.kind === 'run-failed' || event.kind === 'run-cancelled') reject(new Error(JSON.stringify(event)));
    }));
    const calls = input.observeServerCalls().slice(beforeCalls);
    const permissions = input.observePermissions().slice(beforePermissions);
    if (setting === 'off') {
      expect(calls).toEqual([]);
      expect(permissions).toEqual([]);
    } else {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.privateTokenDelivered).toBe(true);
      expect(permissions).toEqual([expect.objectContaining({ server: 'a', serverId: 'catalog-a', tool: 'echo',
        decision: 'approved', prompted: setting === 'ask' })]);
      expect(permissions[0]!.order).toBeLessThan(calls[0]!.order);
    }
    await runtime.dispose();
  } finally {
    try { for (const runtime of runtimes) await runtime.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});


it('witnesses native MCP calls only in a completed Pi window', async () => {
  const input = createPiMcpToolPolicyContractFixture();
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-mcp-usage-'));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    runtime = await input.openSession({ kind: 'create', sessionId: 'pi-mcp-usage', cwd,
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])) });
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch(event => events.push(event));
    for (let call = 0; call < 2; call++) {
      await input.invokeTool(runtime, { server: 'a', tool: 'echo', arguments: {}, approvalScope: 'once' });
    }
    const usage = events.filter(event => event.kind === 'mcp-tool-usage');
    expect(usage).toHaveLength(2);
    expect(usage).toMatchObject([0, 1].map(() => ({ coverage: 'complete',
      servers: [{ serverName: 'a', toolCallCount: 1, schemaBytes: null },
        { serverName: 'b', toolCallCount: 0, schemaBytes: null }] })));
    expect(new Set(usage.map(event => event.turnId)).size).toBe(2);
    expect(events.filter(event => event.kind === 'tool-call').map(event => event.toolName)).toEqual(['mcp__a__echo', 'mcp__a__echo']);
  } finally {
    try { await runtime?.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});
