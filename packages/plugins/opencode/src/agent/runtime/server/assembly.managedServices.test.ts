import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHappierMcpToolNamingResolver } from '../../../../../../../apps/cli/src/mcp/runtime/projectMcpToolNames';
import { join } from 'node:path';

import { buildOpenCodeSessionMcpProjection } from './mcpRegistration.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type { AgentSessionModelsSnapshot, AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionModesSnapshot, AgentSessionModesSource } from '@happier-dev/plugin-sdk/agents/runtime';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '../../auth/services/requestAuth/env.js';
import {
  resolveOpenCodeConnectedConfigHomeDir,
  resolveOpenCodeRequestAuthV2PluginDir,
  resolveOpenCodeRequestAuthV2PluginSourcePath,
} from '../../auth/services/requestAuth/index.js';
import { materializeOpenCodeAuthEnvironment } from '../../auth/services/materialize.js';

import { createContextFixture } from './assembly.managedServices.testkit.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenCode server managed-service assembly', () => {
  it.each(['omitted', 'custom', 'malformed', 'refused'] as const)(
    'admits detached prompts only after their declared MCP dependencies settle (%s)', async (configuration) => {
      const registrations: string[] = [];
      let promptDispatched = false;
      const ctx = createContextFixture({
        managedServerBaseUrl: 'http://127.0.0.1:49213',
        managedServerRequest: async (input) => {
          const path = input.pathAndQuery.split('?')[0]!;
          if (path === '/event') return {
            ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({ start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
              input.signal?.addEventListener('abort', () => controller.close(), { once: true });
            } }),
          };
          const posted = input.body === undefined ? {} : JSON.parse(new TextDecoder().decode(input.body));
          if (path === '/mcp') registrations.push(posted.name);
          if (path.endsWith('/message') && input.method === 'POST') promptDispatched = true;
          const body = path === '/session' ? { id: 'oc-optional-mcp' }
            : path === '/mcp' ? { [posted.name]: configuration === 'refused'
              ? { status: 'failed', error: 'bridge unavailable' } : { status: 'connected' } }
              : path.endsWith('/message') ? { id: 'native-optional-mcp-input' } : {};
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
            body: new Response(JSON.stringify(body)).body };
        },
      });
      const mcpServers = configuration === 'omitted' ? undefined
        : configuration === 'custom' ? { docs: { command: '/fixture/docs-mcp' } }
          : configuration === 'malformed' ? { ' happier ': {} }
            : { happier: { command: '/fixture/happier-mcp' } };
      const assembly = await createOpenCodeServerRuntimeAssembly({
        ctx, directory: '/repo', executionRunId: 'run-optional-mcp',
        endpoint: { mode: 'managed-spawn' }, mcpServers,
        request: { kind: 'create', runId: 'run-optional-mcp', cwd: '/repo', input: { text: 'Produce a plan' },
          profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
      });
      try {
        const admission = await assembly.runtime.send({ inputIds: ['optional-mcp-input'], input: { text: 'Produce a plan' },
          delivery: { kind: 'newTurn', turnId: 'optional-mcp-turn' } });
        const admitted = configuration === 'omitted' || configuration === 'custom';
        expect(admission).toMatchObject({ status: admitted ? 'admitted' : 'rejected' });
        expect(promptDispatched).toBe(admitted);
        const expectedRegistrations = buildOpenCodeSessionMcpProjection('run-optional-mcp', mcpServers)
          .registrations.map(registration => registration.projectedName);
        expect(registrations).toEqual(expectedRegistrations);
      } finally {
        await assembly.dispose();
      }
    },
  );

  it.each(['session', 'execution_run'] as const)('launches normalized no-tools without native or MCP tools through %s', async scope => {
    const requests: string[] = [];
    let prompt: Record<string, unknown> | undefined;
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213', managedServerRequest: async input => {
      const path = input.pathAndQuery.split('?')[0]!;
      requests.push(path);
      if (path === '/event') return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
          input.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }) };
      if (input.body !== undefined && (path.includes('/message') || path.includes('/prompt'))) {
        prompt = JSON.parse(new TextDecoder().decode(input.body));
      }
      const body = path === '/session' ? { id: 'oc-no-tools' }
        : path === '/agent' ? [{ name: 'build', mode: 'primary' }, { name: 'happier-no-tools', mode: 'primary' }]
          : path === '/session/oc-no-tools' ? { id: 'oc-no-tools', agent: 'build' }
            : path.endsWith('/message') ? [{ info: { id: 'native-no-tools-input', role: 'user', sessionID: 'oc-no-tools',
              time: { created: Date.now() } }, parts: [{ type: 'text', text: 'Answer with text' }] }]
              : path.endsWith('/prompt_async') ? { id: 'native-no-tools-input' } : {};
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
    } });
    const configuration = { mode: { value: 'plan', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 }, allowedTools: [], unlistedTools: 'deny' as const, options: {} };
    const common = { ctx, directory: '/repo', endpoint: { mode: 'managed-spawn' as const },
      mcpServers: { docs: { command: 'docs-server' } } };
    const assembly = scope === 'session'
      ? await createOpenCodeServerRuntimeAssembly({ ...common, happierSessionId: 'session-no-tools',
        request: { kind: 'create', sessionId: 'session-no-tools', cwd: '/repo', configuration } })
      : await createOpenCodeServerRuntimeAssembly({ ...common, executionRunId: 'run-no-tools',
        request: { kind: 'create', runId: 'run-no-tools', cwd: '/repo', input: { text: 'answer' },
          profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, configuration } });
    try {
      const spec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]![0];
      if (spec.mode.kind !== 'spawn') throw new Error('Expected managed spawn');
      const config = JSON.parse(spec.mode.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
      expect(config.agent?.['happier-no-tools']).toMatchObject({ permission: { '*': 'deny' } });
      expect(config.default_agent).toBe('happier-no-tools');
      expect(requests).not.toContain('/mcp');
      await expect(assembly.runtime.send({ inputIds: ['no-tools-input'], input: { text: 'Answer with text' },
        delivery: { kind: 'newTurn', turnId: 'no-tools-turn' } })).resolves.toEqual({ status: 'admitted' });
      expect(prompt).toMatchObject({ agent: 'happier-no-tools' });
    } finally { await assembly.dispose(); }
  });

  it('refuses no-tools on an external OpenCode server before native admission', async () => {
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213' });
    await expect(createOpenCodeServerRuntimeAssembly({ ctx, directory: '/repo', executionRunId: 'run-external',
      endpoint: { mode: 'external-attach', baseUrl: 'http://127.0.0.1:49213', credential: null },
      request: { kind: 'create', runId: 'run-external', cwd: '/repo', input: { text: 'answer' },
        profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 }, allowedTools: [], unlistedTools: 'deny', options: {} } } }))
      .rejects.toMatchObject({ code: 'opencode_no_tools_requires_managed_server' });
    expect(ctx.managedServices.supervise).not.toHaveBeenCalled();
  });
  it.each(['session', 'execution_run'] as const)('registers scoped host naming and preserves original approvals and cleanup for %s', async (scope) => {
    const original = 'plugin_' + 'long_name_'.repeat(9);
    // The external tools/list response is the boundary fixture. Naming uses
    // the real host owner; admitted daemon inventory is covered in CLI bootstrap.
    const inventoryServer = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'change_title', inputSchema: { type: 'object' } },
        { name: original, inputSchema: { type: 'object' } },
      ] } }));
    });
    inventoryServer.listen(0, '127.0.0.1');
    await once(inventoryServer, 'listening');
    let registered: { name: string; config: { command: string[] } } | undefined;
    const disconnected: string[] = [];
    let assembly: { dispose(): Promise<void> } | undefined;
    try {
      const address = inventoryServer.address();
      if (!address || typeof address === 'string') throw new Error('Inventory fixture has no TCP address');
      const launchConfig = { command: '/fixture/happier-mcp', args: ['--url', `http://127.0.0.1:${address.port}/mcp`] };
      const resolveToolNaming = createHappierMcpToolNamingResolver(launchConfig, async () => {
        const response = await fetch(launchConfig.args[1]!, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
        // This typed fixture only decodes the external inventory, leaving projection to the host owner.
        const message: { result: { tools: Array<{ name: string }> } } = await response.json();
        return message.result.tools.map(tool => tool.name);
      });
      const approvals: unknown[] = [];
      let eventStream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const ctx = createContextFixture({
        managedServerBaseUrl: 'http://127.0.0.1:49213',
        permissionDecision: async request => { approvals.push(request); return { status: 'cancelled' }; },
        managedServerRequest: async input => {
          const path = input.pathAndQuery.split('?')[0]!;
          if (path === '/event') return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
            body: new ReadableStream<Uint8Array>({ start(controller) {
              eventStream = controller;
              controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
              input.signal?.addEventListener('abort', () => controller.close(), { once: true });
            } }) };
          const posted = input.body === undefined ? {} : JSON.parse(new TextDecoder().decode(input.body));
          if (path === '/mcp') registered = posted;
          if (path.endsWith('/disconnect')) disconnected.push(path);
          const body = path === '/session' ? { id: 'oc-naming' }
            : path === '/mcp' ? { [posted.name]: { status: 'connected' } }
              : path === '/permission' ? [] : {};
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
        },
      });
      const common = { ctx, directory: '/repo', endpoint: { mode: 'managed-spawn' as const },
        mcpServers: { happier: launchConfig }, mcpService: { resolveServers: async () => [], resolveToolNaming } };
      assembly = scope === 'session'
        ? await createOpenCodeServerRuntimeAssembly({ ...common, happierSessionId: 'scope-session',
          request: { kind: 'create', sessionId: 'scope-session', cwd: '/repo' } })
        : await createOpenCodeServerRuntimeAssembly({ ...common, executionRunId: 'scope-run',
          request: { kind: 'create', runId: 'scope-run', cwd: '/repo', input: { text: 'work' },
            profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' } } });
      await vi.waitFor(() => expect(registered).toBeDefined());
      const registration = registered!;
      const expectedName = buildOpenCodeSessionMcpProjection(scope === 'session' ? 'scope-session' : 'scope-run', common.mcpServers).requiredHappierServerName;
      expect(registration.name).toBe(expectedName);
      expect(registration.config.command).toEqual([launchConfig.command, ...launchConfig.args, '--tool-name-max-length', '40']);
      const naming = (await resolveToolNaming({ serverName: 'happier', toolNameMaxLength: 40 }))!;
      const alias = naming.tools.find(tool => tool.originalName === original)!.projectedName;
      expect(`${registration.name}_${alias}`.length).toBeLessThanOrEqual(64);
      await vi.waitFor(() => expect(eventStream).toBeDefined());
      eventStream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'permission.asked', properties: {
        id: 'permission-alias', sessionID: 'oc-naming', permission: `${registration.name}_${alias}`, patterns: ['*'],
      } })}\n\n`));
      await vi.waitFor(() => expect(approvals).toEqual([expect.objectContaining({
        subject: expect.objectContaining({ kind: 'tool', name: `mcp__happier__${original}` }),
      })]));
    } finally {
      try {
        await assembly?.dispose();
      } finally {
        await new Promise<void>((resolve, reject) => inventoryServer.close(error => error ? reject(error) : resolve()));
      }
    }
    expect(disconnected).toEqual([`/mcp/${registered!.name}/disconnect`]);
  });

  it('carries open-request MCP policy to the real session permission transport', async () => {
    let permissions: unknown;
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49213',
      managedServerRequest: async (input) => {
        const path = input.pathAndQuery.split('?')[0];
        const posted = input.body === undefined ? {} : JSON.parse(new TextDecoder().decode(input.body));
        if (path === '/session') permissions = posted.permission;
        const body = path === '/session' ? { id: 'oc-policy' }
          : path === '/mcp' ? { [posted.name]: { status: 'connected' } } : {};
        return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
      },
    });
    const mcpServers = { docs: { command: '/fixture/mcp' } };
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx, directory: '/repo', happierSessionId: 'happy-policy',
      endpoint: { mode: 'managed-spawn' }, mcpServers,
      request: { kind: 'create', sessionId: 'happy-policy', cwd: '/repo', mcpServers,
        mcpToolPolicy: { docs: { unlisted: 'ask', tools: { search: 'allow', delete: 'off' } } } },
    });
    try {
      expect(permissions).toEqual(expect.arrayContaining([
        { permission: `${buildOpenCodeSessionMcpProjection('happy-policy', mcpServers).registrations[0]!.projectedName}_search`, pattern: '*', action: 'ask' },
        { permission: `${buildOpenCodeSessionMcpProjection('happy-policy', mcpServers).registrations[0]!.projectedName}_delete`, pattern: '*', action: 'deny' },
      ]));
    } finally { await assembly.dispose(); }
  });
  it.each(['plan', 'default'] as const)('keeps V1 controls staged and rejects unavailable mode %s before prompt delivery', async (mode) => {
    const requests: Array<{ path: string; method: string }> = [];
    const nativeModes: { source: AgentSessionModesSource | null } = { source: null };
    const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213', managedServerRequest: async (input) => {
      requests.push({ path: input.pathAndQuery, method: input.method ?? 'GET' });
      const path = input.pathAndQuery.split('?')[0];
      const body = path === '/session' ? { id: 'oc-v1-staged' }
        : path === '/agent' ? [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }]
        : path === '/provider' ? { all: [{ id: 'openai', models: { luna: { id: 'luna', name: 'Luna' } } }] } : {};
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
    } });
    const admission = createOpenCodeServerRuntimeAssembly({ ctx, directory: '/repo', happierSessionId: 'happy-v1-staged', endpoint: { mode: 'managed-spawn' },
      modes: { bind(source) { nativeModes.source = source; return { dispose() {} }; } },
      request: { kind: 'create', sessionId: 'happy-v1-staged', cwd: '/repo', configuration: {
        mode: { value: mode, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      } } });
    if (mode === 'default') {
      await expect(admission).rejects.toMatchObject({ code: 'native_agent_session_mode_unavailable' });
      expect(nativeModes.source?.read()).toMatchObject({ currentModeId: 'build', modes: [{ id: 'build' }, { id: 'plan' }] });
      expect(requests.some(({ path, method }) => method === 'POST' && path.includes('/message'))).toBe(false);
      return;
    }
    const assembly = await admission;
    try {
      // The real OpenCode producer must keep the observed default separate from the invalid desired mode.
      expect(nativeModes.source?.read()).toMatchObject({ currentModeId: 'build', modes: [{ id: 'build' }, { id: 'plan' }] });
      if (!('updateConfiguration' in assembly.runtime) || !assembly.runtime.updateConfiguration) throw new Error('Session configuration unavailable');
      await expect(assembly.runtime.updateConfiguration({
        mode: { value: 'plan', updatedAtMs: 1 }, model: { value: 'openai/luna', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
      })).resolves.toMatchObject({ status: 'deferred' });
      expect(nativeModes.source?.read().currentModeId).toBe('build');
      expect(requests.some(({ path, method }) => method === 'POST' && (path.endsWith('/model') || path.endsWith('/agent') || path.includes('/message')))).toBe(false);
    } finally { await assembly.dispose(); }
  });

  it('publishes the real V2 inventory on connection and catalog events, retaining failures but clearing a successful withdrawal', async () => {
    let modelRows: unknown[] = [{ id: 'gpt-5.6-luna', providerID: 'openai', name: 'Luna' }];
    let agentRows: unknown[] = ['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'].map((id) => ({ id, name: id }));
    let agentUnavailable = false;
    let unavailable = false;
    let eventStream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let permissionRequested = false;
    let resolvePermission!: (result: Awaited<ReturnType<OpenCodeRuntimeContext['sessions']['current']['permissions']['requestDecision']>>) => void;
    const permissionDecision = new Promise<Awaited<ReturnType<OpenCodeRuntimeContext['sessions']['current']['permissions']['requestDecision']>>>((resolve) => { resolvePermission = resolve; });
    const snapshots: AgentSessionModelsSnapshot[] = [];
    const modeSnapshots: AgentSessionModesSnapshot[] = [];
    const emit = (type: string, directory = '/repo', data: unknown = {}) => {
      if (!eventStream) throw new Error('Provider event stream unavailable');
      eventStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, location: { directory }, data })}\n\n`));
    };
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49212',
      permissionDecision: async () => { permissionRequested = true; return await permissionDecision; },
      managedServerRequest: async (input) => {
        const path = input.pathAndQuery.split('?')[0];
        if (path === '/api/event') {
          const body = new ReadableStream<Uint8Array>({ start(controller) {
            eventStream = controller;
            emit('server.connected');
            input.signal?.addEventListener('abort', () => controller.close(), { once: true });
          } });
          return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body };
        }
        const failed = (unavailable && path === '/api/model') || (agentUnavailable && path === '/api/agent');
        const response = path === '/api/session'
          ? { data: { id: 'oc-catalog' } }
          : path === '/api/provider'
            ? { data: [{ id: 'openai' }] }
            : path === '/api/model' ? { data: modelRows }
              : path === '/api/agent' ? { data: agentRows }
                : path === '/api/session/oc-catalog' ? { data: { id: 'oc-catalog', agent: 'build' } } : { data: [] };
        return { ok: !failed, status: failed ? 503 : 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(response)).body };
      },
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx, directory: '/repo', happierSessionId: 'happy-catalog', endpoint: { mode: 'managed-spawn' },
      mcpServers: { happier: { command: '/fixture/happier-mcp' } },
      mcpService: { resolveServers: async () => [], resolveToolNaming: async () => { throw new Error('V2 must skip unsupported MCP naming preparation'); } },
      // The models service is the public plugin-to-host boundary, not a replacement catalog owner.
      models: { bind(source: AgentSessionModelsSource) {
        snapshots.push(source.read());
        return source.subscribe((snapshot) => snapshots.push(snapshot));
      } },
      modes: { bind(source: AgentSessionModesSource) {
        modeSnapshots.push(source.read());
        return source.subscribe((snapshot) => modeSnapshots.push(snapshot));
      } },
      request: { kind: 'create', sessionId: 'happy-catalog', cwd: '/repo', configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: { opencodeCliGeneration: { value: 'v2', updatedAtMs: 1 } },
      } },
    });
    try {
      await vi.waitFor(() => expect(snapshots.at(-1)?.models).toEqual([expect.objectContaining({ id: 'openai/gpt-5.6-luna', name: 'Luna' })]));
      expect(snapshots.at(-1)?.observedAt).toBeGreaterThan(0);
      await vi.waitFor(() => expect(modeSnapshots.at(-1)).toMatchObject({ currentModeId: 'build', modes: agentRows }));
      agentUnavailable = true;
      emit('agent.updated');
      await vi.waitFor(() => expect(ctx.logger.warn).toHaveBeenCalledWith(expect.any(String), { operation: 'mode_inventory' }));
      expect(modeSnapshots.at(-1)?.modes).toEqual(agentRows);
      agentUnavailable = false;
      agentRows = [];
      emit('agent.updated');
      await vi.waitFor(() => expect(modeSnapshots.at(-1)).toMatchObject({ currentModeId: 'build', modes: [] }));
      emit('permission.asked', '/repo', { id: 'permission-held', sessionID: 'oc-catalog', action: 'bash', resources: ['git status'] });
      await vi.waitFor(() => expect(permissionRequested).toBe(true));
      unavailable = true;
      emit('provider.updated');
      await vi.waitFor(() => expect(ctx.logger.warn).toHaveBeenCalled());
      expect(snapshots.at(-1)?.models).toEqual([expect.objectContaining({ id: 'openai/gpt-5.6-luna' })]);
      unavailable = false;
      modelRows = [];
      emit('model.updated');
      await vi.waitFor(() => expect(snapshots.at(-1)?.models).toEqual([]));
      modelRows = [{ id: 'gpt-5.6-luna', providerID: 'openai', name: 'Luna' }];
      emit('model.updated', '/other-repo');
      emit('server.connected');
      await vi.waitFor(() => expect(snapshots.at(-1)?.models).toEqual([expect.objectContaining({ id: 'openai/gpt-5.6-luna' })]));
      expect(snapshots.at(-1)?.currentModelId).toBeNull();
    } finally { resolvePermission({ status: 'cancelled' }); await assembly.dispose(); }
  });

  it.each(['none', 'agent', 'inventory'] as const)('persists zero-turn V2 controls on the exact native session and rejects failed admission (reject=%s)', async (failure) => {
    // Managed-service HTTP is the external boundary; assembly, client, controller and runtime are real.
    const requests: Array<{ path: string; body: unknown }> = [];
    let nativeModel: unknown = { id: 'gpt-5.6-luna', providerID: 'openai', variant: 'low' };
    let nativeAgent = 'build';
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49211',
      managedServerRequest: async (input) => {
        const path = input.pathAndQuery.split('?')[0]!;
        const body: unknown = input.body ? JSON.parse(new TextDecoder().decode(input.body)) : null;
        requests.push({ path, body });
        const rejected = (failure === 'agent' && path.endsWith('/agent')) || (failure === 'inventory' && path === '/api/model');
        if (path.endsWith('/model') && input.method === 'POST') nativeModel = (body as { model: unknown }).model;
        if (path.endsWith('/agent') && input.method === 'POST' && !rejected) nativeAgent = (body as { agent: string }).agent;
        const response = path === '/api/session'
          ? { data: { id: 'oc-session-zero-turn' } }
          : path === '/api/provider'
            ? { data: [{ id: 'openai' }] }
            : path === '/api/model'
              ? { data: [{ id: 'gpt-5.6-luna', providerID: 'openai', name: 'Luna' }] }
              : path === '/api/session/oc-session-zero-turn'
                ? { data: { id: 'oc-session-zero-turn', model: nativeModel, agent: nativeAgent } }
                : {};
        return {
          ok: !rejected, status: rejected ? 503 : 200, statusText: rejected ? 'Unavailable' : 'OK',
          headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(response)).body,
        };
      },
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx, directory: '/repo', happierSessionId: 'happy-zero-turn', endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'resume', sessionId: 'happy-zero-turn', cwd: '/repo', providerSessionId: 'oc-session-zero-turn',
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 },
          options: { opencodeCliGeneration: { value: 'v2', updatedAtMs: 1 } },
        },
      },
    });
    try {
      if (!('updateConfiguration' in assembly.runtime) || !assembly.runtime.updateConfiguration) throw new Error('Session configuration unavailable');
      const result = await assembly.runtime.updateConfiguration({
        mode: { value: 'plan', updatedAtMs: 2 }, model: { value: 'openai/gpt-5.6-luna', updatedAtMs: 2 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: { reasoning_effort: { value: 'low', updatedAtMs: 2 } },
      });
      expect(result.status).toBe(failure === 'agent' ? 'rejected' : 'applied');
      expect(nativeAgent).toBe(failure === 'agent' ? 'build' : 'plan');
      if (failure !== 'agent') {
        expect(nativeModel).toEqual({ id: 'gpt-5.6-luna', providerID: 'openai', variant: 'low' });
        expect(requests).toContainEqual({ path: '/api/session/oc-session-zero-turn/model', body: { model: nativeModel } });
        await expect(assembly.runtime.prepareTerminalPresentation?.()).resolves.toMatchObject({
          kind: 'provider_attach',
          metadata: { runtimeDescriptorV1: { agent: { providerSessionId: 'oc-session-zero-turn' } } },
        });
      }
      expect(requests.some(({ path }) => path.endsWith('/prompt') || path === '/api/session')).toBe(false);
    } finally { await assembly.dispose(); }
  });

  it('uses the managed-service owner default as the one startup deadline for supervision and health observation', async () => {
    const onWaitUntilHealthy = vi.fn();
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49194',
      onWaitUntilHealthy,
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-startup-deadline',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-startup-deadline',
        cwd: '/repo',
      },
    });

    expect(ctx.managedServices.supervise).toHaveBeenCalledWith(
      expect.objectContaining({ startupTimeoutMs: 30_000 }),
      expect.any(Object),
    );
    expect(onWaitUntilHealthy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 30_000,
    }));
    await assembly.dispose();
  });

  it('keeps explicit V2 authoritative for readiness and the first session request when released opencode exposes both surfaces', async () => {
    // Released OpenCode at the pinned comparator mounts both health surfaces.
    // Re-probing that child would select V1 from `/global/health`, despite the
    // explicit V2 launch contract that also selected `/api/health` readiness.
    const requests: string[] = [];
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49210',
      systemToolExecutablePath: '/usr/local/bin/opencode',
      managedServerRequest: async (input) => {
        requests.push(input.pathAndQuery);
        const path = input.pathAndQuery.split('?')[0];
        const body = path === '/global/health'
          ? { healthy: true, version: '1.18.25' }
          : path === '/api/health'
            ? { healthy: true }
            : path === '/api/session'
              ? { data: { id: 'oc-session-v2' } }
              : {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify(body)).body,
        };
      },
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-opencode2-readiness',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-opencode2-readiness',
        cwd: '/repo',
        configuration: {
          mode: { value: null, updatedAtMs: 0 },
          model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 },
          options: {
            opencodeCliGeneration: { value: 'v2', updatedAtMs: 1 },
          },
        },
      },
    });

    try {
      expect(ctx.exec.systemTools.resolve).toHaveBeenCalledWith(expect.objectContaining({
        toolId: 'opencode-cli-v2',
      }));
      expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.mode).toMatchObject({
        launch: { executable: { kind: 'systemTool', id: 'opencode-cli-v2' } },
      });
      expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.healthCheck).toEqual({
        kind: 'http',
        target: { kind: 'servicePath', path: '/api/info' },
        timeoutMs: 5_000,
      });
      expect(requests[0]).toBe('/api/session');
      expect(requests.some((path) => path.startsWith('/session'))).toBe(false);
    } finally {
      await assembly.dispose();
    }
  });

  it('sends an owned opencode2 server its own /api requests, not just its own health route', async () => {
    // Readiness and request routing must agree: the binary Happier resolved is
    // the one fact that decides which routes the child mounts, so a managed
    // opencode2 server must not be asked for V1 root routes it never serves.
    const requests: string[] = [];
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49212',
      systemToolExecutablePath: '/usr/local/bin/opencode2',
      managedServerRequest: async (input) => {
        requests.push(input.pathAndQuery);
        const body = input.pathAndQuery === '/api/health'
          ? JSON.stringify({ healthy: true })
          : input.pathAndQuery === '/api/session'
            ? JSON.stringify({ data: { id: 'oc-session-v2' } })
            : '{}';
        return {
          ok: input.pathAndQuery !== '/global/health',
          status: input.pathAndQuery === '/global/health' ? 404 : 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(body).body,
        };
      },
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-opencode2-requests',
      endpoint: { mode: 'managed-spawn' },
      env: {
        HAPPIER_OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY: 'direct-api-key-materialization',
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          openai: { type: 'api', key: 'sk-native-api-key' },
        }),
      },
      request: {
        kind: 'create',
        sessionId: 'happy-session-opencode2-requests',
        cwd: '/repo',
      },
    });

    try {
      expect(requests).toContain('/api/session');
      expect(requests.some((path) => path.startsWith('/session'))).toBe(false);
      expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.sessionFork).toEqual({
        conversation: 'supported',
        fromMessage: 'unsupported',
      });
      expect(assembly.runtime.runtimeCapabilities?.tools).toEqual({
        delivery: 'native_mcp',
        support: 'supported',
      });
      expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.compaction).toEqual({
        manual: 'supported',
      });
    } finally {
      await assembly.dispose();
    }
  });

  it('launches V2 with the selected request-auth asset and isolated materialized config', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-v2-request-auth-'));
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49213',
      systemToolExecutablePath: '/usr/local/bin/opencode2',
      managedServerRequest: async (input) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: new Response(input.pathAndQuery === '/api/session'
          ? JSON.stringify({ data: { id: 'oc-session-v2-request-auth' } })
          : '{}').body,
      }),
    });
    let assembly: Awaited<ReturnType<typeof createOpenCodeServerRuntimeAssembly>> | null = null;
    try {
      const materialized = await materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'v2-request-auth-selection',
        rootDir,
        requestAuth: {
          capabilityPath: join(rootDir, 'request-auth', 'capability.json'),
          purposeBindings: [{
            purpose: {
              consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
              purpose: 'openai-codex-model-request',
            },
            target: {
              kind: 'account',
              account: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'profile-a',
              },
            },
          }],
        },
      });
      assembly = await createOpenCodeServerRuntimeAssembly({
        ctx,
        directory: '/repo',
        happierSessionId: 'happy-session-opencode2-request-auth',
        endpoint: { mode: 'managed-spawn' },
        env: materialized.env,
        configParts: materialized.configPart === undefined ? [] : [materialized.configPart],
        request: {
          kind: 'create',
          sessionId: 'happy-session-opencode2-request-auth',
          cwd: '/repo',
        },
      });

      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      const superviseSpec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0];
      const launchEnv = superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null;
      expect(launchEnv).toMatchObject({
        OPENCODE_AUTH_CONTENT: expect.stringContaining('happier-request-auth:openai:1'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          providers: { openai: {} },
          plugins: [resolveOpenCodeRequestAuthV2PluginDir(configHome, 'openai')],
        }),
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: configHome,
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(rootDir, 'request-auth', 'capability.json'),
      });
      await expect(readFile(resolveOpenCodeRequestAuthV2PluginSourcePath(configHome, 'openai'), 'utf8'))
        .resolves.toContain('id: "happier-request-auth-" + PROVIDER');
    } finally {
      await assembly?.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps an owned stable opencode server ready through the legacy /global route', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49211',
      systemToolExecutablePath: '/usr/local/bin/opencode',
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-opencode-readiness',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-opencode-readiness',
        cwd: '/repo',
      },
    });

    try {
      expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.healthCheck).toEqual({
        kind: 'http',
        target: { kind: 'servicePath', path: '/global/health' },
        timeoutMs: 5_000,
      });
      expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.sessionFork).toEqual({
        conversation: 'supported',
        fromMessage: 'unsupported',
      });
      expect(assembly.runtime.runtimeCapabilities?.tools).toEqual({
        delivery: 'native_mcp',
        support: 'supported',
      });
      expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.compaction).toEqual({
        manual: 'supported',
      });
    } finally {
      await assembly.dispose();
    }
  });

  it('falls back to the proven legacy readiness route when the executable cannot be resolved', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49212',
      systemToolResolveError: new Error('opencode is not installed'),
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-unresolved-readiness',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-unresolved-readiness',
        cwd: '/repo',
      },
    });

    try {
      expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.healthCheck).toMatchObject({
        target: { kind: 'servicePath', path: '/global/health' },
      });
      // The fallback is reported rather than silently taken.
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not resolve the OpenCode executable'),
        expect.objectContaining({ healthPath: '/global/health' }),
      );
    } finally {
      await assembly.dispose();
    }
  });

  it('releases an acquired managed server when startup health does not settle', async () => {
    const startupError = new Error('managed server startup did not settle');
    const onManagedServerDispose = vi.fn();
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49195',
      managedServerWaitError: startupError,
      onManagedServerDispose,
    });

    await expect(createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-startup-failed',
      endpoint: { mode: 'managed-spawn' },
      request: {
        kind: 'create',
        sessionId: 'happy-session-startup-failed',
        cwd: '/repo',
      },
    })).rejects.toBe(startupError);

    expect(onManagedServerDispose).toHaveBeenCalledOnce();
  });

  it('keeps managed launch environment inside the exact OpenCode-owned child scope', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49198',
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-env',
      endpoint: { mode: 'managed-spawn' },
      env: {
        HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api"}}',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: '/private/opencode-connected-config',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
        OPENCODE_PERMISSION: 'ambient-permission-must-not-win',
        OPENCODE_SERVER_PASSWORD: 'ambient-password-must-not-win',
        HAPPIER_OPENCODE_SERVER_URL: 'http://attacker.invalid',
        HAPPIER_OPENCODE_PATH: '/tmp/ambient-opencode',
        FOREIGN_SECRET: 'must-not-reach-opencode',
      },
      permissionMode: 'plan',
      request: {
        kind: 'create',
        sessionId: 'happy-session-env',
        cwd: '/repo',
      },
    });

    try {
      const superviseSpec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0];
      expect(superviseSpec?.mode).not.toHaveProperty('baseUrlEnvKey');
      expect(superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null).toEqual({
        HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
        OPENCODE_AUTH_CONTENT: '{"openai":{"type":"api"}}',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        XDG_CONFIG_HOME: '/private/opencode-connected-config',
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
        OPENCODE_PERMISSION: expect.any(String),
      });
      expect(superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : null)
        .not.toHaveProperty('OPENCODE_SERVER_PASSWORD');
      expect(superviseSpec?.clientAccess).toEqual({
        kind: 'hostBasic',
        username: 'opencode',
        injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
      });
    } finally {
      await assembly.dispose();
    }
  });

  it('loads the host-materialized Provider config as OpenCode runtime config', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-provider-'));
    const relativePath = 'opencode/opencode.json';
    const configPath = join(rootPath, relativePath);
    const configContent = JSON.stringify({
      enabled_providers: ['happier_test'],
      model: 'happier_test/gateway-model',
      provider: {
        happier_test: {
          npm: '@ai-sdk/openai-compatible',
          models: { 'gateway-model': { name: 'Gateway model' } },
        },
      },
    });
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(configPath, configContent, 'utf8');

    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49199',
    });
    let assembly: Awaited<ReturnType<typeof createOpenCodeServerRuntimeAssembly>> | null = null;
    try {
      assembly = await createOpenCodeServerRuntimeAssembly({
        ctx,
        directory: '/repo',
        happierSessionId: 'happy-session-provider',
        endpoint: { mode: 'managed-spawn' },
        env: {
          OPENCODE_CONFIG_CONTENT: '{"provider":{"ambient":{}}}',
        },
        request: {
          kind: 'create',
          sessionId: 'happy-session-provider',
          cwd: '/repo',
          providerBinding: {
            connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
            model: { id: 'gateway-model', name: 'Gateway model' },
            materialization: {
              v: 1,
              kind: 'configFile',
              rootPath,
              relativePaths: [relativePath],
            },
          },
        },
      });

      const superviseSpec = vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0];
      const launchEnv = superviseSpec?.mode.kind === 'spawn' ? superviseSpec.mode.launch.env : undefined;
      expect(JSON.parse(launchEnv?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
        ...JSON.parse(configContent),
        provider: { ambient: {}, ...JSON.parse(configContent).provider },
      });
    } finally {
      await assembly?.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('fails closed when a Provider binding cannot be applied to an external server', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-provider-'));
    const relativePath = 'opencode/opencode.json';
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(join(rootPath, relativePath), '{}', 'utf8');

    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49200',
    });
    try {
      await expect(createOpenCodeServerRuntimeAssembly({
        ctx,
        directory: '/repo',
        happierSessionId: 'happy-session-provider-external',
        endpoint: {
          mode: 'external-attach',
          baseUrl: 'http://127.0.0.1:49200',
        },
        request: {
          kind: 'create',
          sessionId: 'happy-session-provider-external',
          cwd: '/repo',
          providerBinding: {
            connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
            model: { id: 'gateway-model', name: 'Gateway model' },
            materialization: {
              v: 1,
              kind: 'configFile',
              rootPath,
              relativePaths: [relativePath],
            },
          },
        },
      })).rejects.toThrow('OpenCode Provider binding requires a managed server');
      expect(ctx.managedServices.supervise).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('fails closed before supervision when request-auth is pointed at an external server', async () => {
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49201',
    });

    await expect(createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-request-auth-external',
      endpoint: {
        mode: 'external-attach',
        baseUrl: 'http://127.0.0.1:49201',
      },
      env: {
        [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/opencode-request-auth/capability.json',
      },
      request: {
        kind: 'create',
        sessionId: 'happy-session-request-auth-external',
        cwd: '/repo',
      },
    })).rejects.toThrow('OpenCode request authentication requires a managed server');

    expect(ctx.managedServices.supervise).not.toHaveBeenCalled();
  });

  it('supervises an external loopback server through SVC09 without requiring the host fetch service', async () => {
    const externalBaseUrl = 'http://127.0.0.1:49202';
    const onManagedServerDispose = vi.fn();
    const requests: string[] = [];
    const ctx = createContextFixture({
      managedServerBaseUrl: externalBaseUrl,
      onManagedServerDispose,
      managedServerRequest: async (input) => {
        requests.push(input.pathAndQuery);
        const body = input.pathAndQuery === '/global/health'
          ? { healthy: true, version: '1.18.25' }
          : input.pathAndQuery === '/session?directory=%2Frepo'
            ? { id: 'oc-session-v1' }
            : {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify(body)).body,
        };
      },
    });
    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-external',
      endpoint: {
        mode: 'external-attach',
        baseUrl: externalBaseUrl,
        credential: null,
      },
      request: {
        kind: 'create',
        sessionId: 'happy-session-external',
        cwd: '/repo',
      },
    });

    expect(ctx.managedServices.supervise).toHaveBeenCalledWith(expect.objectContaining({
      id: 'opencode-server',
      mode: {
        kind: 'attach',
        baseUrl: externalBaseUrl,
      },
      clientAccess: {
        kind: 'declaredSecretBasic',
        username: 'opencode',
        passwordSecretId: 'opencodeServerPassword',
      },
      healthCheck: { kind: 'none' },
    }), expect.any(Object));
    expect(requests.slice(0, 2)).toEqual([
      '/global/health',
      '/session?directory=%2Frepo',
    ]);
    expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.compaction).toEqual({
      manual: 'supported',
    });
    await assembly.dispose();
    expect(onManagedServerDispose).toHaveBeenCalledOnce();
  });

  it('keeps explicit V2 for an external dual-surface server', async () => {
    const externalBaseUrl = 'http://127.0.0.1:49203';
    const requests: string[] = [];
    const ctx = createContextFixture({
      managedServerBaseUrl: externalBaseUrl,
      managedServerRequest: async (input) => {
        requests.push(input.pathAndQuery);
        const path = input.pathAndQuery.split('?')[0];
        const body = path === '/global/health'
          ? { healthy: true, version: '1.18.25' }
          : path === '/api/health'
            ? { healthy: true }
            : path === '/api/session'
              ? { data: { id: 'oc-session-v2' } }
              : {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify(body)).body,
        };
      },
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-external-v2-dual',
      endpoint: { mode: 'external-attach', baseUrl: externalBaseUrl, credential: null },
      request: {
        kind: 'create',
        sessionId: 'happy-session-external-v2-dual',
        cwd: '/repo',
        configuration: {
          mode: { value: null, updatedAtMs: 0 },
          model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 },
          options: { opencodeCliGeneration: { value: 'v2', updatedAtMs: 1 } },
        },
      },
    });

    // An attached V2 server may be the opencode2 preview (/api/health) or the
    // released opencode 2.0.15 (/api/info). The first authenticated operation
    // is the fail-closed reachability check; no single HTTP health path fits both.
    expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.healthCheck).toEqual({ kind: 'none' });
    expect(requests[0]).toBe('/api/session');
    expect(requests.some((path) => path.startsWith('/session'))).toBe(false);
    expect(requests).not.toContain('/global/health');
    expect(assembly.runtime.runtimeCapabilities?.sessionCapabilities?.compaction).toEqual({
      manual: 'supported',
    });
    await assembly.dispose();
  });

  it('auto-attaches to authenticated released OpenCode 2.0.15 without a V1 readiness gate', async () => {
    const requests: string[] = [];
    const ctx = createContextFixture({
      managedServerBaseUrl: 'http://127.0.0.1:49205',
      managedServerRequest: async (input) => {
        requests.push(input.pathAndQuery);
        const path = input.pathAndQuery.split('?')[0];
        const found = path === '/api/info' || path === '/api/session';
        return {
          ok: found,
          status: found ? 200 : 404,
          statusText: found ? 'OK' : 'Not Found',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify(path === '/api/info'
            ? { version: '2.0.15', pid: 123, urls: [], paths: { tmp: '/tmp' } }
            : { data: { id: 'oc-session-v2' } })).body,
        };
      },
    });

    const assembly = await createOpenCodeServerRuntimeAssembly({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-external-released-v2',
      endpoint: { mode: 'external-attach', baseUrl: 'http://127.0.0.1:49205', credential: null },
      request: {
        kind: 'create',
        sessionId: 'happy-session-external-released-v2',
        cwd: '/repo',
        configuration: {
          mode: { value: null, updatedAtMs: 0 },
          model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 },
          options: { opencodeCliGeneration: { value: 'auto', updatedAtMs: 1 } },
        },
      },
    });
    expect(vi.mocked(ctx.managedServices.supervise).mock.calls[0]?.[0]?.healthCheck).toEqual({ kind: 'none' });
    expect(requests.slice(0, 4)).toEqual(['/global/health', '/api/health', '/api/info', '/api/session']);
    expect(requests.some((path) => path.startsWith('/session'))).toBe(false);
    await assembly.dispose();
  });
});
