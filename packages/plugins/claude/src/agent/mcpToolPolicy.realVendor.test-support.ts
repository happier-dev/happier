import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';

/** Real installed Claude and host hooks; only its model endpoint is a fixture. */
export async function createClaudeMcpRealVendorBoundary(input: Readonly<{
  home: string;
  cwd: string;
  sessionId: string;
  observer: AgentLaunchObserverBoundaries;
  recordConfig(path: string): void;
}>) {
  const executable = process.env.HAPPIER_MCP_CLAUDE_BIN
    ?? execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8' }).trim();
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  // A local model fixture cannot classify native auto-mode shell safety. Select
  // ordinary native approvals in the fixture's private configuration directory.
  await writeFile(join(input.home, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
  console.info(`Real vendor: ${version}; isolated HOME; loopback model; no tenant`);
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    if (!request.url?.includes('/messages')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const payload = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };
    const last = [...payload.messages].reverse().find(message => message.role === 'user');
    let call: { server: string; tool: string; arguments: Record<string, unknown> } | undefined;
    if (last?.role === 'user') {
      const parts = typeof last.content === 'string' ? [last.content] : Array.isArray(last.content)
        ? last.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []) : [];
      for (const text of parts) {
        try {
          const candidate = JSON.parse(text);
          if (typeof candidate.server === 'string' && typeof candidate.tool === 'string') call = candidate;
        } catch { /* Native system reminders are not tool instructions. */ }
      }
    }
    const id = randomUUID();
    if (call) console.info('Local model tool request', JSON.stringify({ server: call.server, tool: call.tool,
      offered: payload.tools?.filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name) }));
    const shell = call?.server === '__tool_shell';
    const content = call ? { type: 'tool_use', id, name: shell ? 'Bash' : `mcp__${call.server}__${call.tool}`, input: {} }
      : { type: 'text', text: '' };
    const frames = [
      { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: payload.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: content },
      { type: 'content_block_delta', index: 0, delta: call
        ? { type: 'input_json_delta', partial_json: JSON.stringify(shell ? { command: 'env' } : call.arguments) }
        : { type: 'text_delta', text: 'Fixture done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('No model fixture address');
  const disposables = new Set<{ dispose(): Promise<void> | void }>();
  let shellResult: { output: unknown; isError: boolean } | undefined;
  const hooks = createSessionHooksService({ happyHomeDir: input.home, hasCapability: () => true,
    addDisposable(disposable) { disposables.add(disposable); } });
  const sessionHooks: AgentSessionHostServices['sessionHooks'] = {
    startServer: request => hooks.startServer({ ...request, providerId: 'claude', sessionId: input.sessionId,
      lifecycle: { kind: 'session', sessionId: input.sessionId } }),
    resolveForwarderAssets: () => hooks.resolveForwarderAssets(),
    createPluginDir: request => hooks.createPluginDir({ ...request, providerId: 'claude',
      lifecycle: { kind: 'session', sessionId: input.sessionId } }),
    disposePluginDir: path => hooks.disposePluginDir(path),
    publishProviderTranscript: async () => undefined,
  };
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool' as const, id: 'claude-cli' }, executablePath: executable }) },
    run: async (spec: { args: readonly string[] }) => {
      const stdout = execFileSync(executable, [...spec.args], { env: { HOME: input.home, CLAUDE_CONFIG_DIR: input.home, PATH: process.env.PATH }, encoding: 'utf8' });
      return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
    },
    clients: {
      async spawn(spec: { launch: { args?: readonly string[]; env?: Readonly<Record<string, string>> } }) {
        const argv = spec.launch.args ?? [];
        const env = { ...spec.launch.env, HOME: input.home, CLAUDE_CONFIG_DIR: input.home, PATH: process.env.PATH,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: 'fixture-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
        input.observer.recordLaunch({ argv: [executable, ...argv], env });
        const config = argv[argv.indexOf('--mcp-config') + 1];
        if (config) input.recordConfig(config);
        const child = spawn(executable, [...argv], { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const lines = createInterface({ input: child.stdout });
        const listeners = new Set<(value: unknown) => void | Promise<void>>();
        const shellCallIds = new Set<string>();
        lines.on('line', line => {
          const record = JSON.parse(line);
          if (record.type === 'assistant') for (const part of record.message?.content ?? []) {
            if (part.type === 'tool_use' && part.name === 'Bash') shellCallIds.add(part.id);
          }
          if (record.type === 'user') for (const part of record.message?.content ?? []) {
            if (part.type === 'tool_result' && shellCallIds.has(part.tool_use_id)) shellResult = { output: part.content, isError: part.is_error === true };
          }
          for (const listener of listeners) void listener(record);
        });
        let stderr = '';
        child.stderr.on('data', data => { stderr += String(data); });
        const terminal = new Promise<PluginProcessResult>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ termination: { observed: signal
            ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? 0 }, requestedBy: { kind: 'none' } },
            stdout: new Uint8Array(), stderr: new TextEncoder().encode(stderr), stdoutTruncated: false, stderrTruncated: false }));
        });
        const write = (bytes: Uint8Array) => new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
        const dispose = async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await terminal; lines.close();
        };
        disposables.add({ dispose });
        return { wait: () => terminal, dispose,
          client: { subscribe(listener: (value: unknown) => void | Promise<void>) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
            write: (record: unknown) => write(new TextEncoder().encode(`${JSON.stringify(record)}\n`)) },
          process: { write, async waitForExit() { return (await this.wait()).termination; },
          wait: () => terminal, dispose, closeStdin: async () => { child.stdin.end(); }, onOutput: () => ({ dispose() {} }) } };
      },
    },
  } as unknown as ExecService; // The OS process/stream transport is the external boundary.
  return { exec, sessionHooks, readShellResult: () => shellResult, async dispose() {
    await Promise.allSettled([...disposables].map(disposable => disposable.dispose()));
    model.closeAllConnections();
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
  } };
}
