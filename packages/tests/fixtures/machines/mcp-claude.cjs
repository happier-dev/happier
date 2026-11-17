#!/usr/bin/env node
// External vendor fixture: speaks Claude stream-json and uses the real generated
// Happier MCP command. It contains no Happier implementation or test injection.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('2.1.292 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
if (argv.includes('--help')) { console.log('--input-format --output-format --permission-mode'); process.exit(0); }
const sessionId = randomUUID();
const servers = {};
const requiredFiles = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--mcp-config') {
    let contents = argv[++i];
    if (!contents.startsWith('{')) { requiredFiles.push(contents); contents = fs.readFileSync(contents, 'utf8'); }
    Object.assign(servers, JSON.parse(contents).mcpServers);
  } else if (argv[i] === '--append-system-prompt-file') {
    const path = argv[++i];
    fs.readFileSync(path, 'utf8');
    requiredFiles.push(path);
  }
}
const config = servers.happier;
if (!config) throw new Error('Generated native launch omitted Happier MCP');
const relay = spawn(config.command, config.args || [], { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 0;
const output = readline.createInterface({ input: relay.stdout });
output.on('line', line => {
  const value = JSON.parse(line);
  if (value.id === undefined) return;
  const request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id);
  value.error ? request.reject(new Error(JSON.stringify(value.error))) : request.resolve(value.result);
});
relay.on('exit', code => { for (const request of pending.values()) request.reject(new Error(`MCP relay exited (${code})`)); pending.clear(); });
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const registration = config.env?.HAPPIER_SESSION_MCP_REGISTRATION_ID;
function observe(completed) {
  fs.appendFileSync('mcp-observations.jsonl', JSON.stringify({ registration, nativeFiles: requiredFiles.length, pid: process.pid, completed }) + '\n');
}
const ready = (async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'native-fixture', version: '1' } });
  relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list', {});
  if (!listed.tools.some(tool => tool.name === 'change_title')) throw new Error('Own MCP catalog omitted change_title');
  observe(false);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [{ name: 'happier', status: 'connected' }], model: 'fake', permissionMode: 'default' }));
})();
const input = readline.createInterface({ input: process.stdin });
let chain = ready;
input.on('line', line => {
  if (!line.includes('"user"')) return;
  chain = chain.then(async () => {
    const changed = await rpc('tools/call', { name: 'change_title', arguments: { title: 'Placed MCP reached own Session' } });
    // A bounded Run has no selected Session. The production native Run bridge
    // returns this typed refusal; the parent's registration would change title.
    if (line.includes('RUN_MCP')) {
      if (!JSON.stringify(changed).includes('session_not_selected')) throw new Error('Run reached the wrong MCP registration');
    } else if (changed.isError || JSON.stringify(changed).includes('session_not_selected')) {
      throw new Error('Parent reached the wrong MCP registration');
    }
    observe(true);
    const text = 'MCP_OK native files readable';
    console.log(JSON.stringify({ type: 'assistant', session_id: sessionId, message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }));
  }).catch(error => { console.error(error); process.exitCode = 1; input.close(); relay.kill(); });
});
input.on('close', () => { void chain.finally(() => relay.kill()); });
