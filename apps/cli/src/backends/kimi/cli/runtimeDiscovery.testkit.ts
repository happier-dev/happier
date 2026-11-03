import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

/** Vendor process boundary fixture; Happier discovery and ACP logic remain real. */
export function writeKimiFixture(dir: string, kind: 'current' | 'legacy' | 'malformed'): string {
  const initialize = JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${kind}.initialize.ndjson`, import.meta.url)), 'utf8')).result;
  const path = writeAcpTestAgentScript({ dir, fileName: 'kimi', source: `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const initialize = ${JSON.stringify(initialize)};
const record = ${JSON.stringify(join(dir, 'requests.ndjson'))};
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(record, JSON.stringify({ method: request.method, params: request.params, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = initialize;
  if (['session/new', 'session/load', 'session/fork'].includes(request.method)) result = {
    sessionId: request.method === 'session/fork' ? 'kimi-fixture-fork' : request.params.sessionId || 'kimi-fixture-session',
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }] },
    configOptions: [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'auto', name: 'Auto' }] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'kimi-for-coding', options: [{ value: 'kimi-for-coding', name: 'Kimi for Coding' }] },
    ],
  };
  if (['session/new', 'session/load', 'session/fork'].includes(request.method)) {
    const home = process.env.KIMI_CODE_HOME || ${JSON.stringify(join(dir, 'kimi-home'))};
    const sessionDir = join(home, 'sessions', 'fixture-workspace', result.sessionId);
    mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
    appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({
      sessionId: result.sessionId, sessionDir, workDir: process.cwd(),
    }) + '\\n');
    const wire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wire)) writeFileSync(wire, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\\n');
  }
  if (request.method === 'session/prompt') result = { stopReason: 'end_turn' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
` });
  chmodSync(path, 0o755);
  return path;
}
