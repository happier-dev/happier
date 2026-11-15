import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { SessionCapabilityNoticeV1Schema } from '@happier-dev/protocol';
import { buildPiHappierToolsExtensionSource } from './extensionSource.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

type Tool = Readonly<{
  name: string;
  execute(callId: string, args: unknown, signal: AbortSignal | undefined, update: undefined,
    ctx: { cwd: string; ui: { confirm(title: string, message: string): Promise<boolean> } }): Promise<unknown>;
}>;

// A real child process is the MCP system boundary; extension logic is unmocked.
const serverSource = `
import { createInterface } from 'node:readline';
let calls = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = message.params.cursor
    ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
    : { tools: [{ name: 'toString', inputSchema: { type: 'object' } }], nextCursor: 'second' };
  else if (message.method === 'tools/call') {
    calls++;
    result = message.params.arguments.text === 'fail'
      ? { isError: true, content: [{ type: 'text', text: 'fixture tool failed' }] }
      : { content: [{ type: 'text', text: process.env.MCP_FIXTURE_PREFIX + message.params.arguments.text }], structuredContent: { calls } };
  }
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
lines.on('close', () => process.exit(0));
`;

describe('Pi extension user MCP', () => {
  it.each(['spawn', 'initialize', 'list'] as const)('isolates optional %s failure, publishes its typed notice, and cleans every child', async stage => {
    await checkStartupFailure(stage, false);
  });

  it.each(['spawn', 'initialize', 'list'] as const)('refuses strict %s failure and cleans every child', async stage => {
    await checkStartupFailure(stage, true);
  });

  it.each([
    { enabledTools: ['echo'], mcpToolPolicy: undefined },
    { enabledTools: undefined, mcpToolPolicy: { fixture: { unlisted: 'ask', tools: { toString: 'off', echo: 'allow' } } } },
    { enabledTools: undefined, mcpToolPolicy: { fixture: { unlisted: 'deny', tools: { echo: 'ask' } } } },
  ] satisfies readonly Readonly<{
    enabledTools: string[] | undefined;
    mcpToolPolicy: AgentSessionOpenRequest['mcpToolPolicy'];
  }>[])('filters unavailable tools, keeps confirmation for Allow, and closes the real stdio server ($mcpToolPolicy)', async ({ enabledTools, mcpToolPolicy }) => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-user-mcp-'));
    // Observe the real subprocess boundary used by the emitted native extension.
    const nativeChildProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
    const spawnBoundary = vi.spyOn(nativeChildProcess, 'spawn');
    syncBuiltinESMExports();
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools: Tool[] = [];
    try {
      const extensionPath = join(root, 'extension.mjs');
      const serverPath = join(root, 'server.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(serverPath, serverSource);
      writeFileSync(configPath, JSON.stringify({
        v: 1, sessionId: 'session', directory: root, systemPrompt: '', tools: [],
        launch: { executablePath: process.execPath, argsPrefix: [] },
        mcpServers: { fixture: { command: process.execPath, args: [serverPath], env: { MCP_FIXTURE_PREFIX: 'user:' }, enabledTools } },
        mcpToolPolicy,
      }));
      const module = await import(pathToFileURL(extensionPath).href);
      let activeTools = ['read'];
      module.default({
        registerFlag() {}, getFlag: () => configPath,
        registerTool(tool: Tool) { tools.push(tool); },
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});
      await expect.poll(() => tools.map(tool => tool.name)).toEqual(['mcp__fixture__echo']);
      expect(spawnBoundary.mock.calls[0]?.[2]?.windowsHide).toBe(true);
      expect(activeTools).toEqual(['read', 'mcp__fixture__echo']);
      const tool = tools[0]!;
      await expect(tool.execute('denied', { text: 'denied' }, undefined, undefined,
        { cwd: root, ui: { confirm: async () => false } })).rejects.toThrow(/denied/i);
      const prompts: string[] = [];
      const result = await tool.execute('allowed', { text: 'hello' }, undefined, undefined,
        { cwd: root, ui: { confirm: async title => { prompts.push(title); return true; } } });
      expect(prompts).toHaveLength(1);
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'user:hello' }], details: { structuredContent: { calls: 1 } } });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(tool.execute('cancelled', {}, cancelled.signal, undefined,
        { cwd: root, ui: { confirm: async () => { throw new Error('must not ask after cancellation'); } } }))
        .rejects.toThrow(/cancelled/i);
      await expect(tool.execute('failed', { text: 'fail' }, undefined, undefined,
        { cwd: root, ui: { confirm: async () => true } })).rejects.toThrow('fixture tool failed');
    } finally {
      for (const handler of handlers.get('session_shutdown') ?? []) await handler({});
      spawnBoundary.mockRestore();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function checkStartupFailure(stage: 'spawn' | 'initialize' | 'list', strict: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'happier-pi-mcp-startup-'));
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools: Tool[] = [];
  const notices: unknown[] = [];
  const write = fs.writeSync;
  // The Pi stdout pipe is the transport boundary; generated extension logic and
  // the exact host consumer schema are real.
  const stdout = vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
    const text = String(args[1]);
    if (text.includes('happier-pi-mcp-capability-notice')) {
      expect(args[0]).toBe(1);
      notices.push(JSON.parse(text));
      return Buffer.byteLength(text);
    }
    return write(...args);
  });
  const pidPaths = ['good', 'broken', 'later'].map(name => join(root, `${name}.pid`));
  try {
    const extensionPath = join(root, 'extension.mjs');
    const serverPath = join(root, 'server.mjs');
    const brokenPath = join(root, 'broken.mjs');
    const configPath = join(root, 'config.json');
    const pidSource = `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PID_FILE, String(process.pid));\n`;
    writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
    writeFileSync(serverPath, pidSource + serverSource);
    writeFileSync(brokenPath, pidSource + serverSource.replace('let result;', `
      if (message.method === ${JSON.stringify(stage === 'initialize' ? 'initialize' : 'tools/list')}
        ${stage === 'list' ? '&& message.params.cursor' : ''}) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: 'private-startup-diagnostic-sentinel' } }) + '\\n');
        return;
      }
      let result;`));
    writeFileSync(configPath, JSON.stringify({ v: 1, directory: root, systemPrompt: '', tools: [],
      mcpServersStrictMode: strict,
      mcpServers: {
        good: { command: process.execPath, args: [serverPath], env: { PID_FILE: pidPaths[0], MCP_FIXTURE_PREFIX: 'good:' } },
        broken: { command: stage === 'spawn' ? join(root, 'missing-command') : process.execPath,
          args: [brokenPath], env: { PID_FILE: pidPaths[1] } },
        later: { command: process.execPath, args: [serverPath], env: { PID_FILE: pidPaths[2], MCP_FIXTURE_PREFIX: 'later:' } },
      },
    }));
    const module = await import(pathToFileURL(extensionPath).href);
    let activeTools: string[] = [];
    module.default({ registerFlag() {}, getFlag: () => configPath,
      registerTool(tool: Tool) { tools.push(tool); }, getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    });
    const start = async () => { for (const handler of handlers.get('session_start') ?? []) await handler({}); };
    if (strict) {
      const startup = start();
      await expect(startup).rejects.toThrow(/MCP/);
      await startup.catch(error => expect(String(error)).not.toContain('private-startup-diagnostic-sentinel'));
    }
    else {
      await start();
      // Optional discovery now settles independently of native startup and peers.
      await expect.poll(() => activeTools.slice().sort()).toEqual([
        'mcp__good__toString', 'mcp__good__echo', 'mcp__later__toString', 'mcp__later__echo',
      ].sort());
      const echo = tools.find(tool => tool.name === 'mcp__good__echo')!;
      expect(await echo.execute('good-call', { text: 'alive' }, undefined, undefined,
        { cwd: root, ui: { confirm: async () => true } })).toMatchObject({ content: [{ type: 'text', text: 'good:alive' }] });
      expect(tools.some(tool => tool.name.startsWith('mcp__broken__'))).toBe(false);
    }
    await expect.poll(() => notices).toHaveLength(1);
    const wire = notices[0] as { notice: unknown };
    expect(SessionCapabilityNoticeV1Schema.parse(wire.notice)).toEqual({ v: 1,
      items: [{ kind: 'mcp_server', name: 'broken', code: `mcp_${stage}_failed` }] });
    expect(JSON.stringify(notices)).not.toContain('private-startup-diagnostic-sentinel');
    for (const handler of handlers.get('session_shutdown') ?? []) { await handler({}); await handler({}); }
    for (const pidPath of pidPaths) {
      try {
        const pid = Number(readFileSync(pidPath, 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  } finally {
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({});
    stdout.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}
