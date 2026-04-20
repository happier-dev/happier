import { afterEach, describe, expect, it } from 'vitest';

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiRpcIntrospectionFailureScript(dir: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-introspection-failure.js');
  const script = `
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 'pi-session-1',
          sessionFile: process.env.SESSION_FILE_PATH,
          model: { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o mini' },
        },
      });
      return;
    case 'get_available_models':
      out({ id: command.id, type: 'response', command: 'get_available_models', success: false, error: 'not supported' });
      return;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: 'get_commands', success: false, error: 'not supported' });
      return;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
      return;
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRpcBackend introspection failures', () => {
  let workDir: string | null = null;
  let backend: PiRpcBackend | null = null;

  afterEach(async () => {
    try {
      await backend?.dispose();
    } finally {
      backend = null;
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('does not fail startSession when get_available_models/get_commands fail', async () => {
    workDir = makeTempDir('happier-pi-introspection-failure-');
    const piDir = join(workDir, 'pi-agent');
    const sessionsDir = join(piDir, 'sessions', '--workdir--');
    const authPath = join(piDir, 'auth.json');
    const sessionPath = join(sessionsDir, `2026-02-18T00-00-00-000Z_pi-session-1.jsonl`);

    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 999999999 } }) + '\\n');
    writeFileSync(sessionPath, '{"role":"system","content":[{"type":"text","text":"stub"}]}' + '\\n');

    const fake = makeFakePiRpcIntrospectionFailureScript(workDir);
    backend = new PiRpcBackend({
      cwd: workDir,
      command: process.execPath,
      args: [fake],
      env: {
        PI_CODING_AGENT_DIR: piDir,
        SESSION_FILE_PATH: sessionPath,
      },
    });

    const started = await backend.startSession();
    expect(started.sessionId).toBe('pi-session-1');
  });
});

