import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeMcpStdioServerTools } from '@/mcp/servers/probeMcpStdioServerTools';
import { createSupervisedMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';

// A real subprocess is the external MCP boundary. The native preparation
// fixture deliberately supplies a different child from the raw config.
const server = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], String(process.pid));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'admitted', version: '1' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'admitted_ready', inputSchema: { type: 'object' } }] } : undefined;
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('MCP probe consumes the admitted native transport', () => {
  it('discovers tools from the supervised child and physically settles it without executing raw config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-admitted-transport-'));
    const marker = join(directory, 'pid');
    const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
      args: ['-e', server, marker], env: process.env, maxStdoutBytes: 0, maxStderrBytes: 0 });
    try {
      const result = await probeMcpStdioServerTools({ config: { command: 'must-not-execute-raw-config', args: [] },
        prepareTransport: async () => ({ transport: createSupervisedMcpStdioTransport(supervised), stderr: supervised.child.stderr }) });
      expect(result.tools.map(tool => tool.name)).toEqual(['admitted_ready']);
      const pid = Number(await readFile(marker, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
      expect((await supervised.waitForSettlement()).remainder).toBeUndefined();
    } finally { await supervised.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('closes a prepared child when cancellation arrives before MCP connect', async () => {
    const controller = new AbortController();
    const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
      args: ['-e', 'process.stdin.resume()'], env: process.env, maxStdoutBytes: 0, maxStderrBytes: 0 });
    try {
      await expect(probeMcpStdioServerTools({ config: { command: 'must-not-execute-raw-config', args: [] },
        signal: controller.signal, prepareTransport: async () => {
          controller.abort(new Error('fixture_cancelled'));
          return { transport: createSupervisedMcpStdioTransport(supervised), stderr: supervised.child.stderr };
        } })).rejects.toThrow('fixture_cancelled');
      expect(supervised.child.exitCode !== null || supervised.child.signalCode !== null).toBe(true);
      expect((await supervised.waitForSettlement()).remainder).toBeUndefined();
    } finally { await supervised.dispose(); }
  });
});
