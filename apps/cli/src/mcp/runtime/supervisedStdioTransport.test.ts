import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { spawnSupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { encodeAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { createSupervisedMcpStdioTransport } from './supervisedStdioTransport';

// The OS child consumes the real host-frame encoding before it speaks MCP.
// This proves byte ordering and process custody, not a switched native UID.
const fixture = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], String(process.pid));
let buffer = Buffer.alloc(0);
let admitted = false;
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!admitted) {
    if (buffer.length < 12) return;
    if (!buffer.subarray(0,8).equals(Buffer.from('HAPAGT1\n'))) process.exit(3);
    const length = buffer.readUInt32BE(8);
    if (buffer.length < 12 + length) return;
    const frame = JSON.parse(buffer.subarray(12,12+length));
    if (frame.environment.SELECTED_FIXTURE !== 'selected') process.exit(4);
    admitted = true;
    buffer = buffer.subarray(12+length);
  }
  for (;;) {
    const end = buffer.indexOf(10);
    if (end < 0) break;
    const message = JSON.parse(buffer.subarray(0,end).toString());
    buffer = buffer.subarray(end+1);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') result = {
      protocolVersion:message.params.protocolVersion, capabilities:{tools:{}},
      serverInfo:{name:'framed-fixture',version:'1'}
    };
    else if (message.method === 'tools/list') {
      if (process.argv[2] === 'pending') {
        fs.writeFileSync(process.argv[1]+'.pending','ready'); continue;
      }
      result = {tools:[{name:'selected_tool',inputSchema:{type:'object'}}]};
    } else continue;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  }
});
`;

describe('supervised MCP stdio transport', () => {
  it.each(['normal', 'pending'] as const)('preserves the frame and settles the actual %s MCP child', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-framed-mcp-'));
    const marker = join(directory, 'pid');
    const supervised = spawnSupervisedPluginProcess({ command: process.execPath,
      args: ['-e', fixture, marker, mode], maxStdoutBytes: 0, maxStderrBytes: 0,
      stdinPreamble: encodeAgentLaunchFrame({ v: 1, executable: process.execPath, args: [],
        cwd: directory, runtimeHome: directory, environment: { SELECTED_FIXTURE: 'selected' }, selectedMaterials: [] }) });
    const client = new Client({ name: 'framed-client', version: '1' });
    try {
      const transport = createSupervisedMcpStdioTransport(supervised);
      await client.connect(transport);
      if (mode === 'normal') {
        expect(await client.listTools()).toMatchObject({ tools: [{ name: 'selected_tool' }] });
      } else {
        const pending = client.listTools();
        const rejected = expect(pending).rejects.toBeDefined();
        await vi.waitFor(async () => expect(await readFile(`${marker}.pending`, 'utf8')).toBe('ready'));
        await client.close();
        await rejected;
      }
      const pid = Number(await readFile(marker, 'utf8'));
      await client.close();
      await supervised.waitForSettlement();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      await client.close();
      await supervised.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
