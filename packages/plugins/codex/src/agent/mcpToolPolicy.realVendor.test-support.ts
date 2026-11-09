import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { createCodexNativeAppServerClient } from './runtime/appServer/client.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime, type CodexAppServerRuntimeHost } from './runtime/appServer/runtime.js';
import { createCodexNativeAppServerSessionRuntime } from './runtime/appServer/native.js';
import { assignInjectedServerKeys } from './runtime/appServer/config/overrides.js';
import { resolveCodexTerminalPermissionPolicy } from './runtime/terminal/permissionPolicy.js';

/** Runs installed Codex. The only simulated peer is the loopback Responses API. */
export async function openRealCodexMcpSession(request: AgentSessionOpenRequest, input: Readonly<{
  home: string; observer: AgentLaunchObserverBoundaries; interactions: CodexAppServerRuntimeHost['ui'];
}>): Promise<AgentSessionRuntime> {
  const executable = process.env.HAPPIER_MCP_CODEX_BIN
    ?? execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8' }).trim();
  console.info(`Real vendor: ${execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()}; isolated HOME; loopback model; no tenant`);
  const keys = assignInjectedServerKeys(Object.keys(request.mcpServers ?? {}));
  const model = createServer(async (incoming, response) => {
    if (incoming.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of incoming) body += String(chunk);
    const payload = JSON.parse(body) as { input: Record<string, unknown>[]; tools?: Record<string, unknown>[] };
    const last = [...payload.input].reverse().find(item => item.role === 'user');
    const afterUser = last ? payload.input.slice(payload.input.lastIndexOf(last) + 1) : [];
    const hasToolResult = afterUser.some(item => item.type === 'function_call_output');
    let call: { server: string; tool: string; arguments: Record<string, unknown> } | undefined;
    if (last?.role === 'user' && Array.isArray(last.content)) {
      for (const part of last.content) {
        if (part.type !== 'input_text' || typeof part.text !== 'string') continue;
        try { const candidate = JSON.parse(part.text); if (typeof candidate.server === 'string') call = candidate; } catch { /* Native reminders are not instructions. */ }
      }
    }
    const key = call ? keys.get(call.server) : undefined;
    const flat = (payload.tools ?? []).flatMap(tool => tool.type === 'namespace' && Array.isArray(tool.tools)
      ? tool.tools.map(child => ({ ...child, namespace: tool.name })) : [tool]);
    if (call) console.info('Local model tool request', JSON.stringify({ server: call.server, tool: call.tool,
      offered: flat.map(tool => ({ name: tool.name, namespace: tool.namespace })), deferred: flat.filter(tool => !tool.name) }));
    const shell = call?.server === '__tool_shell';
    const tool = shell ? flat.find(tool => tool.name === 'shell_command' || tool.name === 'exec_command') : call ? flat.find(tool => typeof tool.name === 'string' && (tool.name.includes(`${key}__${call!.tool}`)
      || (tool.name === call!.tool && tool.namespace === `mcp__${key!.replace(/[^a-zA-Z0-9_]/g, '_')}`))) : undefined;
    const id = `resp_${randomUUID()}`;
    const item = call && tool && !hasToolResult ? { type: 'function_call', id: `fc_${randomUUID()}`, call_id: randomUUID(),
      name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(shell
        ? tool.name === 'exec_command' ? { cmd: 'env' } : { command: 'env' } : call.arguments), status: 'completed' }
      : { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Fixture done', annotations: [] }] };
    const result = { id, object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const frames = [ { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: result } ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const address = model.address(); if (!address || typeof address === 'string') throw new Error('No local model fixture address');
  const env = { HOME: input.home, CODEX_HOME: input.home, PATH: process.env.PATH };
  const children = new Set<{ dispose(): Promise<void> }>();
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: executable }) },
    run: async (spec: { args: readonly string[] }) => ({ stdout: new TextEncoder().encode(execFileSync(executable, [...spec.args], { env, encoding: 'utf8' })),
      stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } }),
    clients: { async spawn(spec: { launch: { args?: readonly string[]; env?: Record<string, string> } }) {
      const argv = spec.launch.args ?? []; const launchEnv = { ...spec.launch.env, ...env };
      input.observer.recordLaunch({ argv: [executable, ...argv], env: launchEnv });
      const child = spawn(executable, [...argv], { cwd: request.cwd, env: launchEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = createInterface({ input: child.stdout });
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
      const requests = new Map<string, (request: { id: number | string; params: unknown }) => Promise<unknown>>();
      const notifications = new Set<(message: { method: string; params: unknown }) => Promise<void> | void>();
      const notificationReceipts = new Set<(message: { method: string; params: unknown; receivedAtMs: number }) => void>();
      let next = 0; let stderr = '';
      const write = (record: unknown) => new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : resolve()));
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') {
          if (message.method.toLowerCase().includes('mcp')) console.info('Real Codex MCP status', JSON.stringify(message));
          if (message.method.startsWith('item/') && message.params?.item?.type === 'mcpToolCall') {
            console.info('Real Codex MCP correlation', JSON.stringify(message));
          }
          if (message.id !== undefined) {
            const handler = requests.get(message.method);
            void Promise.resolve(handler ? handler(message) : null).then(result => write({ id: message.id, result }));
          } else {
            const receivedAtMs = Date.now();
            for (const listener of notificationReceipts) listener({ ...message, receivedAtMs });
            for (const listener of notifications) void listener(message);
          }
        } else {
          const waiter = pending.get(message.id); pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(JSON.stringify(message.error))); else waiter?.resolve(message.result);
        }
      });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const terminal = new Promise<PluginProcessResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { for (const waiter of pending.values()) waiter.reject(new Error(`Codex exited: ${stderr}`));
          resolve({ termination: { observed: signal ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? 0 }, requestedBy: { kind: 'none' } },
            stdout: new Uint8Array(), stderr: new TextEncoder().encode(stderr), stdoutTruncated: false, stderrTruncated: false }); });
      });
      const dispose = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await terminal; lines.close(); };
      children.add({ dispose });
      return { wait: () => terminal, dispose, client: {
        request(method: string, params: unknown) { input.observer.recordAppServerRequest(method, params);
          const id = ++next; const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject })); void write({ id, method, params }); return result; },
        notify: (method: string, params: unknown) => write({ method, ...(params === undefined ? {} : { params }) }),
        onRequest(method: string, handler: (request: { id: number | string; params: unknown }) => Promise<unknown>) { requests.set(method, handler); return { dispose() { requests.delete(method); } }; },
        onNotificationReceived(listener: (message: { method: string; params: unknown; receivedAtMs: number }) => void) { notificationReceipts.add(listener); return { dispose() { notificationReceipts.delete(listener); } }; },
        onNotification(listener: (message: { method: string; params: unknown }) => Promise<void> | void) { notifications.add(listener); return { dispose() { notifications.delete(listener); } }; },
      } };
    } },
  } as unknown as ExecService; // Actual OS JSON-RPC transport is the external boundary.
  const runtime = createCodexAppServerRuntime({ directory: request.cwd, happierSessionId: request.sessionId,
    mcpServers: request.mcpServers, mcpToolPolicy: request.mcpToolPolicy, initialModelId: 'fixture',
    initialPermissionMode: request.configuration?.permissionIntent.value ?? 'default', processEnv: env,
    resolveCurrentPolicy: () => resolveCodexTerminalPermissionPolicy(request.configuration?.permissionIntent.value ?? 'default'),
    host: { baseProcessEnv: env, logger: { debug() {}, warn() {} }, ui: input.interactions,
      createClient: options => createCodexNativeAppServerClient({ ...options, exec,
        configOverrides: [...options.configOverrides, 'model_provider="fixture"',
          `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false}`,
          'features.responses_websockets=false', 'features.code_mode=false'] }) },
  });
  const cleanup = async () => { await Promise.allSettled([...children].map(child => child.dispose())); model.closeAllConnections();
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())); };
  try {
    await startCodexAppServerRuntime(runtime, request.kind === 'resume'
      ? { resumeId: request.providerSessionId, strictNativeResumeIdentity: true }
      : undefined);
    const session = createCodexNativeAppServerSessionRuntime(runtime, request.sessionId, undefined, undefined, request.mcpToolPolicy);
    session.watch(input.observer.recordRuntimeEvent);
    return { ...session, async dispose() { try { await session.dispose(); } finally { await cleanup(); } } };
  } catch (error) { await cleanup(); throw error; }
}
