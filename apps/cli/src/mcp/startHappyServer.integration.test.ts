import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Metadata } from '@/api/types';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { reloadConfiguration } from '@/configuration';
import { registerExecutionRunHandlers as registerExecutionRunHandlersBase } from '@/rpc/handlers/executionRuns';
import { HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';
import {
  registerHappierSessionAgentToolRpc,
  startHappyServer as startHappyServerBase,
  type HappyMcpSessionClient,
} from '@/mcp/startHappyServer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

const env = process.env;

const getTestServerBinding = () => ({
  serverId: 'test-home',
  serverUrl: 'https://test-home.example.test',
} as const);

type TestExecutionRunRuntimeFactory = (opts: Readonly<{
  runId?: string;
  backendId: string;
  backendTarget?: unknown;
  permissionMode: string;
  modelId?: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: unknown;
}>) => ExecutionRunHostRuntime;

const runtimeFactoryState = vi.hoisted(() => ({
  current: null as TestExecutionRunRuntimeFactory | null,
}));

vi.mock('@/agent/runtime/bridges/executionRun/createExecutionRunBridgeRuntime', () => ({
  createExecutionRunBridgeRuntime: vi.fn((opts: Parameters<TestExecutionRunRuntimeFactory>[0]) => {
    const factory = runtimeFactoryState.current;
    if (!factory) {
      throw new Error('Missing test execution-run runtime factory');
    }
    return factory(opts);
  }),
}));

type TestExecutionRunHandlerContext = Parameters<typeof registerExecutionRunHandlersBase>[1] & Readonly<{
  createBackend?: TestExecutionRunRuntimeFactory;
}>;

function registerExecutionRunHandlers(
  rpc: Parameters<typeof registerExecutionRunHandlersBase>[0],
  ctx: TestExecutionRunHandlerContext,
): void {
  const { createBackend, ...baseCtx } = ctx;
  runtimeFactoryState.current = createBackend ?? (() => {
    throw new Error('Missing test execution-run runtime factory');
  });
  registerExecutionRunHandlersBase(rpc, {
    ...baseCtx,
    executionRunProfileCatalog: baseCtx.executionRunProfileCatalog ?? buildExecutionRunProfileCatalog(),
  });
}

function createStaticRuntime(responseText: string): ExecutionRunHostRuntime {
  let fullText = '';

  let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
  runtime = createTestExecutionRunHostRuntime({
    runtimeId: 'child_sess_1',
    onSendPrompt() {
      fullText = responseText;
      runtime.emitMessage({ type: 'model-output', fullText });
    },
  });
  return runtime;
}

function parseMcpJsonText(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Missing MCP text response');
  }
  return JSON.parse(text);
}

function isTextResourceContentEntry(
  entry: unknown,
): entry is { uri: string; text: string; mimeType?: string | undefined } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return typeof record.uri === 'string' && typeof record.text === 'string';
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createDefaultActiveTurnPermissionWitness(turnId: string) {
  return {
    turnId,
    causalPermissionAuthority: {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'default' as const,
    },
  };
}

let pluginRuntimeHomeDir: string | null = null;
let pluginRuntimeRegistryLease: PluginRuntimeRegistryLease | undefined;

function startHappyServer(...[client, opts]: Parameters<typeof startHappyServerBase>) {
  return startHappyServerBase(client, { ...opts, pluginRuntimeRegistryLease });
}

describe('startHappyServer (MCP integration)', () => {
  beforeAll(async () => {
    pluginRuntimeHomeDir = await mkdtemp(join(tmpdir(), 'happier-mcp-plugin-runtime-'));
    pluginRuntimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        generation: 1,
        happyHomeDir: pluginRuntimeHomeDir!,
      }),
    });
  });

  afterAll(async () => {
    await pluginRuntimeRegistryLease?.release();
    pluginRuntimeRegistryLease = undefined;
    await pluginReloadController.shutdown();
    if (pluginRuntimeHomeDir) {
      await rm(pluginRuntimeHomeDir, { recursive: true, force: true });
      pluginRuntimeHomeDir = null;
    }
  });

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    delete process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS;
    reloadConfiguration();
  });

  it('emits SSE keepalive comments on the standalone GET stream (prevents idle timeouts)', async () => {
    const prev = process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS;
    process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS = '25';
    reloadConfiguration();

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_keepalive_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_keepalive_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticRuntime(JSON.stringify({ ok: true })),
      sendAcp: async () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_keepalive_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
    };

    const server = await startHappyServer(fakeClient);
    try {
      const url = new URL(server.url);
      const firstChunk = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let timeoutId: NodeJS.Timeout | null = null;
        const finish = (value: { ok: true; chunk: string } | { ok: false; error: Error }) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          if (value.ok) resolve(value.chunk);
          else reject(value.error);
        };

        const req = httpRequest(
          {
            method: 'GET',
            host: url.hostname,
            port: Number(url.port),
            path: `${url.pathname}${url.search}`,
            headers: {
              Accept: 'text/event-stream',
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              finish({ ok: false, error: new Error(`Unexpected status: ${res.statusCode}`) });
              req.destroy();
              return;
            }
            res.once('data', (chunk) => {
              finish({ ok: true, chunk: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) });
              req.destroy();
            });
            res.once('end', () => {
              finish({ ok: false, error: new Error('SSE stream ended before any keepalive data was received') });
            });
            res.once('close', () => {
              finish({ ok: false, error: new Error('SSE stream closed before any keepalive data was received') });
            });
          },
        );
        req.on('error', (err) => finish({ ok: false, error: err instanceof Error ? err : new Error(String(err)) }));
        req.end();

        timeoutId = setTimeout(() => {
          req.destroy();
          finish({ ok: false, error: new Error('Timed out waiting for SSE keepalive chunk') });
        }, 1000);
      });

      // SSE comments start with ":" and are safe to interleave with event streams.
      expect(firstChunk).toContain(':');
    } finally {
      server.stop();
      if (prev === undefined) delete process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS;
      else process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS = prev;
      reloadConfiguration();
    }
  });

  it('snapshots tool names from account action settings when provided', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_account_tool_names_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_account_tool_names_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
    };

    const server = await startHappyServer(fakeClient, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': { disabledSurfaces: [], toolExposureModes: { agent: 'direct' } },
          },
        },
      },
    } as any);
    try {
      expect(server.toolNames).toContain('session_list');
    } finally {
      server.stop();
    }
  });

  it('owns native Agent tool dispatch on the live Session and rejects caller-supplied authority fields', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_native_agent_tool_rpc_1',
      encryptionMode: 'plain',
    });
    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_native_agent_tool_rpc_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
      getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn_native_agent_tool_rpc_1',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
        },
      }),
    };

    registerHappierSessionAgentToolRpc(fakeClient, { pluginRuntimeRegistryLease });
    await expect(rpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
      {
        toolName: 'action_spec_get',
        args: { id: 'session.list' },
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'yolo',
        },
      },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_input',
      error: 'invalid_action_input',
    });

    await expect(rpcHandlerManager.invokeLocal(
      SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
      {
        toolName: 'action_spec_get',
        args: { id: 'session.list' },
        toolCallId: 'native_tool_call_rpc_1',
      },
    )).resolves.toMatchObject({ ok: true });
  });

  it('executes discoverable-only execution-run actions through action_execute over HTTP transport', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'happier-coderabbit-review-remote-'));
    const workspace = await mkdtemp(join(tmpdir(), 'happier-coderabbit-review-workspace-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);
    runGit(workspace, ['init', '--initial-branch=main']);
    await writeFile(join(workspace, 'a.txt'), 'base\n', 'utf8');
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);
    await writeFile(join(workspace, 'a.txt'), 'base\nfeature\n', 'utf8');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'feature']);
    const sent: Array<{ body: ACPMessageData; meta?: Record<string, unknown> }> = [];

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () =>
        createStaticRuntime(
          JSON.stringify({
            findings: [
              { id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' },
            ],
            summary: 'Summary.',
          }),
        ),
      sendAcp: async (_provider: string, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => {
        sent.push({ body, meta: opts?.meta });
      },
      streamedTranscriptSession: {
        enqueueAgentMessageCommitted: async (_provider, body, opts) => {
          sent.push({ body, meta: opts.meta });
          return { persisted: true, delivered: true };
        },
      },
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
      getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => createDefaultActiveTurnPermissionWitness('turn_mcp_1'),
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const tools = await client.listTools();
      const names = new Set((tools.tools ?? []).map((t: any) => String(t.name)));
      expect(names.has('action_spec_search')).toBe(true);
      expect(names.has('action_spec_get')).toBe(true);
      expect(names.has('action_options_resolve')).toBe(true);
      expect(names.has('action_execute')).toBe(true);
      expect(names.has('review_start')).toBe(false);
      expect(names.has('subagents_plan_start')).toBe(false);
      expect(names.has('subagents_delegate_start')).toBe(false);
      expect(names.has('execution_run_start')).toBe(false);
      expect(names.has('execution_run_list')).toBe(true);
      expect(names.has('execution_run_get')).toBe(true);
      expect(names.has('execution_run_wait')).toBe(true);
      expect(names.has('execution_run_action')).toBe(false);

      const resolvedOptionsRaw = await client.callTool({
        name: 'action_options_resolve',
        arguments: {
          actionId: 'subagents.plan.start',
          fieldPath: 'backendTargetKeys',
          sessionId: fakeClient.sessionId,
        },
      });
      const resolvedOptions = parseMcpJsonText(resolvedOptionsRaw);
      expect(resolvedOptions.actionId).toBe('subagents.plan.start');
      expect(resolvedOptions.fieldPath).toBe('backendTargetKeys');
      expect(resolvedOptions.optionsSourceId).toBe('execution.backends.enabled');
      expect(resolvedOptions.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: 'agent:happier.agent.claude/claude',
            label: expect.any(String),
          }),
        ]),
      );
      const claudeBackendOption = resolvedOptions.options.find((option: any) => option.value === 'agent:happier.agent.claude/claude');
      expect(claudeBackendOption).toBeTruthy();

      const planRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'subagents.plan.start',
          input: {
            sessionId: fakeClient.sessionId,
            backendTargetKeys: [claudeBackendOption.value],
            instructions: 'Plan with the resolved backend option.',
          },
        },
      });
      const plan = parseMcpJsonText(planRaw);
      expect(plan.intent).toBe('plan');
      expect(plan.results?.[0]).toEqual(expect.objectContaining({
        key: 'agent:happier.agent.claude/claude',
        ok: true,
      }));
      const planRunId = plan.results[0].result.runId;
      expect(String(planRunId)).toMatch(/^run_/);

      const startedRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.start',
          input: {
            sessionId: fakeClient.sessionId,
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review.',
            permissionMode: 'read_only',
            retentionPolicy: 'resumable',
            runClass: 'bounded',
            ioMode: 'request_response',
          },
        },
      });
      const started = parseMcpJsonText(startedRaw);
      expect(started).toEqual(expect.objectContaining({ runId: expect.stringMatching(/^run_/) }));

      const startedRunId = started.runId;

      const gotNoStructuredRaw = await client.callTool({
        name: 'action_execute',
        arguments: { actionId: 'execution.run.get', input: { runId: startedRunId } },
      });
      const gotNoStructured = parseMcpJsonText(gotNoStructuredRaw);
      expect(gotNoStructured.run?.runId).toBe(startedRunId);
      expect(gotNoStructured.structuredMeta).toBeUndefined();

      const gotStructuredRaw = await client.callTool({
        name: 'action_execute',
        arguments: { actionId: 'execution.run.get', input: { runId: startedRunId, includeStructured: true } },
      });
      const gotStructured = parseMcpJsonText(gotStructuredRaw);
      expect(gotStructured.structuredMeta?.kind).toBe('review_findings.v2');
      expect(gotStructured.structuredMeta?.payload?.runRef?.runId).toBe(startedRunId);

      const actionRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.action',
          input: {
            runId: startedRunId,
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
          },
        },
      });
      const action = parseMcpJsonText(actionRaw);
      expect(action).toEqual(expect.objectContaining({
        updatedToolResult: expect.objectContaining({ ok: true, actionId: 'review.triage' }),
      }));

      // Verify the run emitted tool-call/tool-result into transcript (via sendAcp).
      expect(sent.some((m) => (m.body as any)?.type === 'tool-call')).toBe(true);
      expect(sent.some((m) => (m.body as any)?.type === 'tool-result')).toBe(true);
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('routes change_title through session metadata updates instead of provider-specific summary messages', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_change_title_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    let metadata: Metadata = {
      path: '/tmp/project',
      host: 'localhost',
      homeDir: '/tmp/home',
      happyHomeDir: '/tmp/happy',
      happyLibDir: '/tmp/happy/lib',
      happyToolsDir: '/tmp/happy/tools',
      flavor: 'claude',
    };
    const updateMetadata = vi.fn((updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });

    const fakeClient = {
      sessionId: 'sess_mcp_change_title_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata,
    } satisfies HappyMcpSessionClient;

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-change-title', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const resultRaw = await client.callTool({
        name: 'change_title',
        arguments: { title: 'QA MCP Title' },
      });
      const result = parseMcpJsonText(resultRaw);

      expect(result.success).toBe(true);
      expect(updateMetadata).toHaveBeenCalled();
      expect((metadata.summary as { text?: string }).text).toBe('QA MCP Title');
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('surfaces execution_run_start app-level failures as MCP tool errors', async () => {
    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_run_start_error_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: vi.fn(async (method: string) => {
          if (method === 'execution.run.start') {
            return {
              ok: false,
              errorCode: 'execution_run_budget_exceeded',
              error: 'Execution run budget exceeded',
            };
          }
          return {};
        }),
      } as any,
      updateMetadata: () => {},
      getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => createDefaultActiveTurnPermissionWitness('turn_mcp_run_start_error_1'),
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-run-start-error', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const resultRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.start',
          input: {
            sessionId: fakeClient.sessionId,
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review.',
            permissionMode: 'read_only',
            retentionPolicy: 'resumable',
            runClass: 'bounded',
            ioMode: 'request_response',
          },
        },
      });
      expect(resultRaw.isError).toBe(true);
      expect(parseMcpJsonText(resultRaw)).toEqual({
        errorCode: 'execution_run_budget_exceeded',
        error: 'Execution run budget exceeded',
        details: {
          executionRunStart: {
            v: 1,
            runCreation: 'outcomeUnknown',
          },
        },
      });
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('fails closed instead of retargeting execution-run actions to the MCP-bound session', async () => {
    const invokeLocal = vi.fn(async () => ({ ok: true }));
    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_bound_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal } as any,
      updateMetadata: () => {},
      getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn_mcp_scope_1',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'default',
        },
      }),
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-run-scope', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const startRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.start',
          input: {
            sessionId: 'sess_foreign_1',
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review.',
            permissionMode: 'default',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
          },
        },
      });
      expect(startRaw.isError).toBe(true);
      expect(parseMcpJsonText(startRaw)).toEqual(expect.objectContaining({
        errorCode: 'execution_run_scope_mismatch',
      }));

      const detachedStartRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.start',
          input: {
            sessionId: null,
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            instructions: 'Review.',
            permissionMode: 'default',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
          },
        },
      });
      expect(detachedStartRaw.isError).toBe(true);
      expect(parseMcpJsonText(detachedStartRaw)).toEqual(expect.objectContaining({
        errorCode: 'not_authenticated',
      }));

      const stopRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.stop',
          input: { sessionId: 'sess_foreign_1', runId: 'run_foreign_1' },
        },
      });
      expect(stopRaw.isError).toBe(true);
      expect(parseMcpJsonText(stopRaw)).toEqual(expect.objectContaining({
        errorCode: 'execution_run_scope_mismatch',
      }));
      expect(invokeLocal).not.toHaveBeenCalled();
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('surfaces execution_run_send app-level failures as MCP tool errors', async () => {
    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_run_send_error_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: vi.fn(async (method: string) => {
          if (method === 'execution.run.send') {
            return {
              ok: false,
              errorCode: 'execution_run_not_allowed',
              error: 'Not running',
            };
          }
          return {};
        }),
      } as any,
      updateMetadata: () => {},
      getPermissionMode: () => 'default',
      getActiveTurnPermissionWitness: () => createDefaultActiveTurnPermissionWitness('turn_mcp_run_send_error_1'),
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-run-send-error', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const resultRaw = await client.callTool({
        name: 'action_execute',
        arguments: {
          actionId: 'execution.run.send',
          input: {
            runId: 'run_1',
            message: 'still there?',
          },
        },
      });
      expect(fakeClient.rpcHandlerManager.invokeLocal).toHaveBeenCalledWith(
        'execution.run.send',
        expect.objectContaining({
          runId: 'run_1',
          message: 'still there?',
          delivery: 'steer_if_supported',
        }),
      );
      expect(resultRaw.isError).toBe(true);
      expect(parseMcpJsonText(resultRaw)).toEqual({
        errorCode: 'execution_run_not_allowed',
        error: 'Not running',
      });
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('uses the live session metadata snapshot for MCP action_options_resolve inventory lookups', async () => {
    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_options_metadata_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: vi.fn(async () => ({})),
      } as any,
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({
        sessionModesV1: {
          currentModeId: 'build',
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      } as Metadata),
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-action-options-metadata', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const resultRaw = await client.callTool({
        name: 'action_options_resolve',
        arguments: {
          optionsSourceId: 'session.modes.available',
          sessionId: fakeClient.sessionId,
        },
      });
      expect(resultRaw.isError).toBe(false);
      expect(parseMcpJsonText(resultRaw)).toEqual({
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      });
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('hides session-agent-disabled action-spec tools and rejects action_spec_get for disabled actions', async () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_disabled_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_disabled_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticRuntime(JSON.stringify({ ok: true })),
      sendAcp: async () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_disabled_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-disabled', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const tools = await client.listTools();
      const names = new Set((tools.tools ?? []).map((t: any) => String(t.name)));
      expect(names.has('review_start')).toBe(false);
      expect(names.has('subagents_plan_start')).toBe(false);

      const got = await client.callTool({
        name: 'action_spec_get',
        arguments: { id: 'review.start' },
      });
      const parsed = parseMcpJsonText(got);
      expect(parsed.errorCode).toBe('action_disabled');
    } finally {
      await (client as any)?.close?.();
      server.stop();
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });

  it('lists and reads Happier MCP resources over HTTP transport', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_resources_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_resources_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticRuntime(JSON.stringify({ ok: true })),
      sendAcp: async () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_resources_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
    };

    const server = await startHappyServer(fakeClient);
    let client: Client | null = null;
    try {
      client = new Client({ name: 'mcp-test-resources', version: '1.0.0' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      const resources = await withTimeout(client.listResources(), 'resources/list');
      const actionSpecsResource = resources.resources.find(
        (resource: any) => String(resource.uri) === HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI,
      );
      expect(actionSpecsResource).toBeDefined();

      const read = await withTimeout(
        client.readResource({ uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI }),
        'resources/read',
      );
      const textContent = read.contents.find(
        (entry) => isTextResourceContentEntry(entry) && entry.uri === HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI,
      );
      expect(textContent?.mimeType).toBe('application/json');
      expect(textContent && 'text' in textContent).toBe(true);
      if (!textContent || !('text' in textContent)) {
        throw new Error('Expected text MCP resource content');
      }

      const parsed = JSON.parse(textContent.text);
      expect(Array.isArray(parsed.actionSpecs)).toBe(true);
      expect(parsed.actionSpecs.some((spec: any) => spec.id === 'review.start')).toBe(true);
    } finally {
      await (client as any)?.close?.();
      server.stop();
    }
  });

  it('allows multiple independent MCP clients to connect without sharing transport initialization state', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'sess_mcp_seq_1',
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    });

    registerExecutionRunHandlers(rpcHandlerManager, {
      sessionId: 'sess_mcp_seq_1',
      cwd: process.cwd(),
      parentProvider: 'claude',
      createBackend: () => createStaticRuntime(JSON.stringify({ ok: true })),
      sendAcp: async () => {},
    });

    const fakeClient: HappyMcpSessionClient = {
      sessionId: 'sess_mcp_seq_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager,
      updateMetadata: () => {},
    };

    const server = await startHappyServer(fakeClient);
    try {
      const clientA = new Client({ name: 'mcp-test-a', version: '1.0.0' }, { capabilities: {} });
      const clientB = new Client({ name: 'mcp-test-b', version: '1.0.0' }, { capabilities: {} });

      await clientA.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const toolsA = await clientA.listTools();
      const namesA = new Set((toolsA.tools ?? []).map((t: any) => String(t.name)));
      expect(namesA.has('action_execute')).toBe(true);
      expect(namesA.has('execution_run_start')).toBe(false);

      await clientB.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      const toolsB = await clientB.listTools();
      const namesB = new Set((toolsB.tools ?? []).map((t: any) => String(t.name)));
      expect(namesB.has('action_execute')).toBe(true);
      expect(namesB.has('execution_run_start')).toBe(false);

      await (clientA as any).close?.();
      await (clientB as any).close?.();
    } finally {
      server.stop();
    }
  });
});
