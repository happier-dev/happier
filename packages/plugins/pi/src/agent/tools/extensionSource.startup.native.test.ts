import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from './assets.js';
import { buildPiRpcLaunch } from '../runtime/rpc/args.js';

// Real supported Pi executables and stdio MCP peers are the system boundaries.
// A socket holds one peer's initialize reply until the test explicitly releases it.
describe('Pi optional MCP startup', () => {
  it.each([
    { version: '0810', heldMethod: 'initialize', releasePeer: true },
    { version: '0821', heldMethod: 'initialize', releasePeer: true },
    { version: '0821', heldMethod: 'tools/list', releasePeer: false },
  ])('Pi $version keeps pending $heldMethod outside readiness and cleans peers (release=$releasePeer)', async ({ version, heldMethod, releasePeer }) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-optional-mcp-'));
    const sockets = new Set<Socket>();
    let blocked: Socket | undefined;
    const peers = new Set<number>();
    const gate = createNetServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', chunk => {
        const request = JSON.parse(String(chunk)) as { name: string; pid: number };
        peers.add(request.pid);
        if (request.name === 'slow') blocked = socket;
        else socket.end('release');
      });
    });
    const inventories: string[][] = [];
    const model = createHttpServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const payload = JSON.parse(body);
      inventories.push(payload.tools.map((tool: { name: string }) => tool.name));
      const records = [
        { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: payload.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(records.map(record => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`).join(''));
    });
    let child: ReturnType<typeof spawn> | undefined;
    let prepared: Awaited<ReturnType<typeof preparePiHappierToolsExtension>> | undefined;
    const frames: Record<string, unknown>[] = [];
    const observedTools = new Map<string, string[]>();
    try {
      gate.listen(0, '127.0.0.1'); model.listen(0, '127.0.0.1');
      await Promise.all([once(gate, 'listening'), once(model, 'listening')]);
      const gateAddress = gate.address(); const modelAddress = model.address();
      if (!gateAddress || typeof gateAddress === 'string' || !modelAddress || typeof modelAddress === 'string') throw new Error('No fixture address');
      writeFileSync(join(root, 'provider.mjs'), `import fs from 'node:fs'; export default pi=>{
        pi.registerProvider('fixture',{baseUrl:'http://127.0.0.1:${modelAddress.port}',apiKey:'synthetic',api:'anthropic-messages',models:[{
        id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192}]});
        pi.registerCommand('qa-tools',{description:'Fixture inventory',handler:async(args)=>{
          fs.writeSync(1,JSON.stringify({type:'qa_tools',id:args,names:pi.getAllTools().map(t=>t.name)})+'\\n');}});
      };`);
      writeFileSync(join(root, 'mcp.mjs'), `import net from 'node:net'; import {createInterface} from 'node:readline';
        const lines=createInterface({input:process.stdin}); lines.on('close',()=>process.exit(0));
        lines.on('line',async line=>{const r=JSON.parse(line); if(r.id===undefined)return;
          if(r.method===${JSON.stringify(heldMethod)})await new Promise(resolve=>{const socket=net.connect(${gateAddress.port},'127.0.0.1',()=>{
            socket.write(JSON.stringify({name:process.argv[2],pid:process.pid}));}); socket.on('data',()=>{}); socket.on('close',resolve);});
          const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
            :r.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'ok'}]};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
      prepared = await preparePiHappierToolsExtension({ directory: root, mcpServers: {
        slow: { command: process.execPath, args: [join(root, 'mcp.mjs'), 'slow'] },
        healthy: { command: process.execPath, args: [join(root, 'mcp.mjs'), 'healthy'] },
      } });
      const launch = buildPiRpcLaunch({ happierToolsExtension: prepared });
      child = spawn(process.execPath, [resolve(`../../../node_modules/pi-coding-agent-${version}/dist/cli.js`),
        ...launch.args, '--no-session', '--extension', join(root, 'provider.mjs'), '--provider', 'fixture', '--model', 'fixture'],
      { cwd: root, env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
      createInterface({ input: child.stdout! }).on('line', line => {
        const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame);
        if (frame.type === 'qa_tools') observedTools.set(String(frame.id), frame.names as string[]);
      });
      const send = (id: string, type: string, extra: Record<string, unknown> = {}) => {
        child!.stdin!.write(JSON.stringify({ id, type, ...extra }) + '\n');
      };
      await expect.poll(() => blocked !== undefined, { timeout: 10_000 }).toBe(true);
      send('state', 'get_state');
      // This is the incident boundary: the peer is alive and has not replied.
      await expect.poll(() => frames.some(frame => frame.type === 'response' && frame.id === 'state' && frame.success === true), { timeout: 5_000 }).toBe(true);
      let probe = 0;
      await expect.poll(async () => {
        const id = `tools-${++probe}`; send(id, 'prompt', { message: `/qa-tools ${id}` });
        await expect.poll(() => observedTools.has(id)).toBe(true);
        return observedTools.get(id);
      }).toContain('mcp__healthy__echo');
      send('first', 'prompt', { message: 'Finish without using tools' });
      await expect.poll(() => frames.filter(frame => frame.type === 'agent_end').length).toBe(1);
      expect(inventories[0]).toContain('mcp__healthy__echo');
      expect(inventories[0]).not.toContain('mcp__slow__echo');
      if (releasePeer) {
        blocked!.end('release');
        await expect.poll(async () => {
          const id = `late-${++probe}`; send(id, 'prompt', { message: `/qa-tools ${id}` });
          await expect.poll(() => observedTools.has(id)).toBe(true);
          return observedTools.get(id);
        }).toContain('mcp__slow__echo');
        send('second', 'prompt', { message: 'Finish again without using tools' });
        await expect.poll(() => frames.filter(frame => frame.type === 'agent_end').length).toBe(2);
        expect(inventories[1]).toEqual(expect.arrayContaining(['mcp__healthy__echo', 'mcp__slow__echo']));
      }
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
      for (const pid of peers) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
      }
      for (const socket of sockets) socket.destroy();
      for (const pid of peers) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      gate.close(); model.close();
      await Promise.all([once(gate, 'close'), once(model, 'close')]);
      await prepared?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
