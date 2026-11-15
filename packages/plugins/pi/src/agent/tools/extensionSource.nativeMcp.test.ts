import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from './assets.js';
import { buildPiRpcLaunch } from '../runtime/rpc/args.js';

// Real Pi 0.82.1, real stdio MCP and a synthetic localhost model. No Account material.
describe('Pi native MCP delivery', () => {
  it.each(['default', 'read-only'])('%s delivers the requested user tool natively and witnesses the actual provider inventory', async permissionMode => {
    const root = mkdtempSync(join(tmpdir(), 'pi-native-mcp-'));
    const name = 'mcp__usage_qa_called_r164p__read_active_fixture_status';
    const payloads: string[][] = [];
    const frames: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const payload = JSON.parse(body);
      payloads.push(payload.tools.map((tool: { name: string }) => tool.name));
      const call = !payload.messages.at(-1).content.some((part: { type: string }) => part.type === 'tool_result');
      const records = [
        { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: payload.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: call
          ? { type: 'tool_use', id: 'native-mcp-call', name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: call
          ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'Finished' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(records.map(record => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`).join(''));
    });
    let child: ReturnType<typeof spawn> | undefined;
    let prepared: Awaited<ReturnType<typeof preparePiHappierToolsExtension>> | undefined;
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No model address');
      writeFileSync(join(root, 'provider.mjs'), `export default pi=>pi.registerProvider('fixture',{
        baseUrl:'http://127.0.0.1:${address.port}',apiKey:'synthetic',api:'anthropic-messages',models:[{
        id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192}]});`);
      writeFileSync(join(root, 'mcp.cjs'), `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);if(r.id===undefined)return;
        const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
          :r.method==='tools/list'?{tools:[{name:'read_active_fixture_status',inputSchema:{type:'object',properties:{}}}]}
          :{content:[{type:'text',text:'Native MCP succeeded'}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
      // Explicit strict selection requires the complete catalog on the first turn.
      prepared = await preparePiHappierToolsExtension({ directory: root, permissionMode, mcpServersStrictMode: true,
        mcpServers: { usage_qa_called_r164p: { command: process.execPath, args: [join(root, 'mcp.cjs')] },
          unused: { command: process.execPath, args: [join(root, 'mcp.cjs')] } } });
      const launch = buildPiRpcLaunch({ permissionMode, happierToolsExtension: prepared });
      child = spawn(process.execPath, [resolve('../../../node_modules/pi-coding-agent-0821/dist/cli.js'),
        ...launch.args, '--no-session', '--extension', join(root, 'provider.mjs'), '--provider', 'fixture', '--model', 'fixture'],
      { cwd: root, detached: process.platform !== 'win32', env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
      const native = child;
      const completed = new Promise<void>((resolveDone, reject) => {
        createInterface({ input: native.stdout! }).on('line', line => {
          const frame = JSON.parse(line); frames.push(frame);
          if (frame.type === 'extension_ui_request' && frame.method === 'confirm') {
            native.stdin!.write(JSON.stringify({ type: 'extension_ui_response', id: frame.id, confirmed: true }) + '\n');
          }
          if (frame.type === 'agent_end') resolveDone();
        });
        native.once('error', reject);
        native.once('exit', () => reject(new Error('Native child exited before completion')));
      });
      native.stdin!.write(JSON.stringify({ id: 'fixture-prompt', type: 'prompt', message: 'Finish' }) + '\n');
      await completed;
      expect(payloads).toHaveLength(2);
      expect(payloads.every(tools => tools.includes(name))).toBe(true);
      if (permissionMode === 'read-only') expect(payloads.flat().filter(tool => ['bash', 'write', 'edit'].includes(tool))).toEqual([]);
      expect(frames).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_execution_start', toolName: name }),
        expect.objectContaining({ type: 'tool_execution_end', isError: false })]));
      expect(frames.filter(frame => frame.type === 'happier-pi-mcp-delivery')).toEqual(payloads.map(tools => ({
        type: 'happier-pi-mcp-delivery', tools: tools.filter(tool => tool.startsWith('mcp__')),
      })));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid!, 'SIGTERM');
        await once(child, 'close');
      }
      server.close(); await once(server, 'close');
      await prepared?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
