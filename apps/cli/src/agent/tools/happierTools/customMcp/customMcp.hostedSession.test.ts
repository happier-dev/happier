import { describe, expect, it } from 'vitest';
import { runAddedHostedSession, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { callResolvedCustomHappierTool } from './callResolvedCustomHappierTool';
import { listResolvedCustomHappierTools } from './listResolvedCustomHappierTools';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { serveSessionTargetRelay, SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import { createStableDeclaredMcpTransportConnector } from '@/plugins/runtime/invocation/services/mcpDeclaredTransport';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

// The MCP server is a real subprocess: discovery, protocol handling and calls
// remain on their production paths, including their default environment.
const server = String.raw`
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const scope = process.env.HAPPIER_MCP_SCOPE_TEST || 'missing';
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'scope', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'scope_' + scope, inputSchema: { type: 'object' } }] }
    : request.method === 'tools/call' ? { content: [{ type: 'text', text: scope }] } : undefined;
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

async function declaredToolNames() {
  let released = false;
  const connector = createStableDeclaredMcpTransportConnector({ resolveExecutable: async () => ({
    command: process.execPath, args: ['-e', server],
    env: { HAPPIER_MCP_SCOPE_TEST: sessionProcessEnvironment().HAPPIER_MCP_SCOPE_TEST ?? 'missing' },
    release: () => { released = true; },
  }) });
  let client: Awaited<ReturnType<typeof connector>> | undefined;
  try {
    client = await connector({
      declaration: { provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.mcp',
        manifestPath: '/fixture/plugin.json', daemonEntryPath: '/fixture/daemon.js',
        definition: { id: 'scope', title: 'Scope', kind: 'static', sessionScope: 'session',
          transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture.mcp' } } } },
      ref: { pluginId: 'fixture.mcp', localId: 'scope' }, sessionId: 'session', elicitation: { mode: 'reject' },
      seed: { plugin: { id: 'fixture.caller', version: '1' },
        contribution: { id: 'run', qualifiedId: 'fixture.caller/actions/run' },
        occurrenceId: createPluginRuntimeOccurrenceId('fixture.caller'), correlationId: 'mcp-scope', surface: 'agent',
        session: { id: 'session' }, signal: new AbortController().signal, isOccurrenceCurrent: () => true },
    });
    return (await client.listTools()).items.map(tool => tool.name);
  } finally { await client?.dispose(); expect(released).toBe(true); }
}

describe('custom MCP hosted Session environment', () => {
  const holder = resolveSessionHolderExecutablePath();
  it.skipIf(process.platform === 'win32' || !holder).each(['custom', 'declared', 'unavailable'] as const)('places %s MCP operations in the Session target', async kind => {
    const directory = await mkdtemp('/tmp/mcp-target-');
    const targetRoot = join(directory, 'workspace');
    await mkdir(targetRoot);
    const lifetime = new AbortController();
    const channels: ChildProcess[] = [];
    const relay = await serveSessionTargetRelay({ socketPath: join(directory, 'relay.sock'), lifetime: lifetime.signal,
      readTrustedCallerPid: () => process.pid,
      operations: {
        exec: (command, signal) => new Promise((resolve, reject) => {
          const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], signal });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          child.once('error', reject);
          child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
        }),
        openChannel: (argv, signal) => {
          const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
          channels.push(child);
          signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
          const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
          child.once('close', () => channel.destroy());
          return channel;
        },
      } });
    try {
      await runAddedHostedSession({ environment: { ...process.env, HAPPIER_MCP_SCOPE_TEST: 'host',
        [SESSION_TARGET_PLACEMENT_ENV_KEY]: JSON.stringify({ id: 'target', holderPath: holder, socketDirectory: directory,
          relaySocketPath: relay.socketPath, launch: { executables: kind === 'unavailable' ? {} : { [process.execPath]: process.execPath },
            env: { HAPPIER_MCP_SCOPE_TEST: 'target' }, workspace: { hostRoot: directory, targetRoot } } }) },
        workingDirectory: directory, end: () => undefined,
      }, async () => {
        if (kind === 'unavailable') {
          const marker = join(directory, 'host-process-started');
          const config = { command: process.execPath, args: ['-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n${server}`] };
          await expect(probeMcpStdioServerTools({ config })).rejects.toMatchObject({ code: 'mcp_tool_catalog_unavailable' });
          await expect(declaredToolNames()).rejects.toMatchObject({ code: -32000 });
          await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        if (kind === 'declared') {
          expect(await declaredToolNames()).toEqual(['scope_target']);
          return;
        }
        const config = { command: process.execPath, args: ['-e', server] };
        const mcpServers = { scoped: config };
        const listed = await listResolvedCustomHappierTools({ mcpServers });
        expect(listed).toMatchObject({ warnings: [], tools: [{ name: 'scope_target' }] });
        const called = await callResolvedCustomHappierTool({ mcpServers, source: 'scoped', toolName: 'scope_target',
          args: {}, operationContext: { isCurrent: async () => true } });
        expect(called).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'target' }] } });
        const probed = await probeMcpStdioServerTools({ config });
        expect(probed.tools.map(tool => tool.name)).toEqual(['scope_target']);
      });
    } finally {
      lifetime.abort();
      for (const child of channels) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('keeps concurrent discovery and calls in their Session (explicit override: %s)', async explicit => {
    await Promise.all(['first', 'second'].map(scope => runAddedHostedSession({
      environment: { ...process.env, HAPPIER_MCP_SCOPE_TEST: scope },
      workingDirectory: process.cwd(), end: () => undefined,
    }, async () => {
      const expected = explicit ? 'override' : scope;
      const processEnv = explicit ? { ...process.env, HAPPIER_MCP_SCOPE_TEST: expected } : undefined;
      const config = { command: process.execPath, args: ['-e', server] };
      const mcpServers = { scoped: config };
      const [listed, called, probed] = await Promise.all([
        listResolvedCustomHappierTools({ mcpServers, processEnv }),
        callResolvedCustomHappierTool({ mcpServers, processEnv, source: 'scoped', toolName: `scope_${expected}`,
          args: {}, operationContext: { isCurrent: async () => true } }),
        probeMcpStdioServerTools({ config, baseEnv: processEnv }),
      ]);
      expect.soft(listed).toMatchObject({ warnings: [], tools: [{ source: 'scoped', name: `scope_${expected}` }] });
      expect.soft(called).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: expected }] } });
      expect.soft(probed.tools.map(tool => tool.name)).toEqual([`scope_${expected}`]);
      expect(await declaredToolNames()).toEqual([`scope_${scope}`]);
    })));
  });
});
